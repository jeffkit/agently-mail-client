'use strict';
/**
 * dashboard-state.js — Dashboard 状态读取层
 *
 * 提供 readState(opts) 函数，从本地各状态文件（pending.json / denied-log.json /
 * batch-queue.json / poll-cursor.json / rpm-stats.json / email-profiles.yaml /
 * email-acl.yaml）聚合出面板需要的 JSON 快照。
 *
 * 与 HTTP 服务器解耦：可独立测试。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { AclConfig }    = require('./acl-config');
const { BatchStore }   = require('./batch-store');
const { PendingStore } = require('./pending-store');
const { DeniedLog }    = require('./denied-log');
const { loadProfilesConfig } = require('./yaml-loader');

/**
 * 读取本地所有状态文件，返回面板需要的 JSON 快照。
 * 每次 /api/state 请求都重新从磁盘读（数据量小，无需缓存）。
 *
 * @param {object} [opts]
 * @param {string} [opts.storeDir]        持久化目录（默认 ~/.agently-mail-client）
 * @param {string} [opts.profilesConfig]  email-profiles.yaml 路径（默认 ./email-profiles.yaml）
 * @param {string} [opts.aclConfig]       email-acl.yaml 路径（默认 ./email-acl.yaml，不存在时为 null）
 * @returns {{
 *   timestamp: string,
 *   lastPollAt: string|null,
 *   profiles: Array<{name:string, trigger:string, description:string, command:string,
 *                    args:string[], workdir:string|null, timeout_ms:number|null,
 *                    system_prompt:string|null, isDefault:boolean}>,
 *   acl: { static: object, dynamic: {allowed:string[], denied:string[]} },
 *   pending: { queued: number, entries: object[] },
 *   batch:   { queued: number, entries: object[] },
 *   denied:  { unreported: number, entries: object[] },
 *   rateLimit: object|null
 * }}
 */
function readState(opts = {}) {
  const storeDir     = opts.storeDir || path.join(os.homedir(), '.agently-mail-client');
  const profilesFile = opts.profilesConfig || path.join(process.cwd(), 'email-profiles.yaml');
  const aclFile      = opts.aclConfig || (() => {
    const c = path.join(process.cwd(), 'email-acl.yaml');
    return fs.existsSync(c) ? c : null;
  })();

  // ── profiles config ──
  let profiles = {};
  let defaultProfile = '';
  try {
    const cfg = loadProfilesConfig(profilesFile);
    profiles = cfg.profiles || {};
    defaultProfile = cfg.default || '';
  } catch {
    // 配置文件不存在或格式错误时返回空
  }

  // ── ACL config ──
  let aclStatic = {};
  let aclDynamic = { allowed: [], denied: [] };
  try {
    const acl = new AclConfig({
      aclConfigFile: aclFile,
      dynamicFile:   path.join(storeDir, 'acl-dynamic.json'),
    });
    aclStatic = {
      allowedSenders:      acl.allowedSenders,
      deniedSenders:       acl.deniedSenders,
      adminSenders:        acl.adminSenders,
      instantReplySenders: acl.instantReplySenders,
      denyAction:          acl.denyAction,
      reportConfig:        acl.reportConfig,
      batchMode:           acl._static?.batch_mode || null,
    };
    aclDynamic = acl.dynamicSnapshot();
  } catch {
    // ACL 未配置时忽略
  }

  // ── pending store ──
  // 先加载 denied-log，用于给 pending 条目打"已拦截"标记（被 ACL 拒绝的邮件
  // 也会被 markReplied 以阻止重试，单看 replied 无法区分"真回复"与"被拦截"）。
  const deniedMap = new Map();
  try {
    const dlPath = path.join(storeDir, 'denied-log.json');
    if (fs.existsSync(dlPath)) {
      const dl = JSON.parse(fs.readFileSync(dlPath, 'utf8'));
      for (const d of (Array.isArray(dl) ? dl : [])) {
        if (d && d.message_id) deniedMap.set(d.message_id, d.reason || 'ACL');
      }
    }
  } catch {
    // denied-log 缺失/损坏不影响 pending 读取
  }

  let pending = { queued: 0, entries: [] };
  try {
    const store = new PendingStore(path.join(storeDir, 'pending.json'));
    const all = store.getPending ? store.getPending() : [];
    const raw = fs.existsSync(path.join(storeDir, 'pending.json'))
      ? JSON.parse(fs.readFileSync(path.join(storeDir, 'pending.json'), 'utf8'))
      : {};
    const entries = Object.values(raw)
      .sort((a, b) => new Date(b.added_at) - new Date(a.added_at))
      .slice(0, 100)
      .map((e) => {
        const reason = deniedMap.has(e.message_id) ? deniedMap.get(e.message_id) : null;
        return reason ? { ...e, denied: true, deny_reason: reason } : e;
      });
    pending = { queued: all.length, entries };
  } catch {
    // 文件不存在时忽略
  }

  // ── batch store ──
  let batch = { queued: 0, entries: [] };
  try {
    const store = new BatchStore(path.join(storeDir, 'batch-queue.json'));
    const queued = store.getQueued();
    const all = store.getAll().sort((a, b) => new Date(b.queued_at) - new Date(a.queued_at)).slice(0, 100);
    batch = { queued: queued.length, entries: all };
  } catch {
    // 批处理未启用时忽略
  }

  // ── denied log ──
  let denied = { unreported: 0, entries: [] };
  try {
    const log = new DeniedLog(path.join(storeDir, 'denied-log.json'));
    const unreported = log.getUnreported ? log.getUnreported() : [];
    const raw = fs.existsSync(path.join(storeDir, 'denied-log.json'))
      ? JSON.parse(fs.readFileSync(path.join(storeDir, 'denied-log.json'), 'utf8'))
      : [];
    const entries = (Array.isArray(raw) ? raw : [])
      .sort((a, b) => new Date(b.received_at) - new Date(a.received_at))
      .slice(0, 50);
    denied = { unreported: unreported.length, entries };
  } catch {
    // 无被拒记录时忽略
  }

  // ── poll cursor ──
  let lastPollAt = null;
  try {
    const cursorFile = path.join(storeDir, 'poll-cursor.json');
    if (fs.existsSync(cursorFile)) {
      const { afterTimestamp } = JSON.parse(fs.readFileSync(cursorFile, 'utf8'));
      lastPollAt = afterTimestamp || null;
    }
  } catch {
    // 无游标时忽略
  }

  // ── rate-limit live stats (written by the bridge process) ──
  let rateLimit = null;
  try {
    const rpmFile = path.join(storeDir, 'rpm-stats.json');
    if (fs.existsSync(rpmFile)) {
      rateLimit = JSON.parse(fs.readFileSync(rpmFile, 'utf8'));
    }
  } catch {
    // stats file missing or corrupt — non-fatal
  }

  return {
    timestamp: new Date().toISOString(),
    lastPollAt,
    profiles: Object.entries(profiles).map(([name, cfg]) => ({
      name,
      trigger:       cfg.trigger || name,
      description:   cfg.description || '',
      command:       cfg.command,
      args:          cfg.args || [],
      workdir:       cfg.workdir || null,
      timeout_ms:    cfg.timeout_ms || null,
      system_prompt: cfg.system_prompt || null,
      isDefault:     name === defaultProfile,
    })),
    acl: { static: aclStatic, dynamic: aclDynamic },
    pending,
    batch,
    denied,
    rateLimit,
  };
}

module.exports = { readState };
