'use strict';
/**
 * AclConfig — 加载并合并 ACL 配置
 *
 * 数据来源（优先级从高到低）：
 *   1. acl-dynamic.json  运行时写入，管理员指令或程序自动维护
 *   2. email-acl.yaml    静态配置，人工编辑，可 git 管理
 *
 * email-acl.yaml 与 email-profiles.yaml 严格分离：
 *   - email-profiles.yaml 只描述 profile 路由规范（command/args/trigger）
 *   - email-acl.yaml 描述所有与 agently mail 访问控制相关的配置
 *
 * 合并规则：
 *   - dynamic.allowed 追加到 static.allowed（动态放行不覆盖静态）
 *   - dynamic.denied  追加到 static.denied（动态封禁不覆盖静态）
 *   - dynamic.allowed 中的地址会从合并后的 denied 中移除（放行优先于封禁）
 *   - admin_senders / deny_action / deny_message / report 仅来自静态配置
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { loadAclConfig } = require('./yaml-loader');

const DEFAULT_STORE_DIR    = path.join(os.homedir(), '.agently-mail-client');
const DEFAULT_DYNAMIC_FILE = path.join(DEFAULT_STORE_DIR, 'acl-dynamic.json');

// 公共邮件域 denylist：把整个公共域配为 admin 会让任何人都能执行
// /allow /deny /reset /status —— 启动时必须拒绝。
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'icloud.com', 'me.com', 'mac.com',
  'qq.com', 'foxmail.com', 'vip.qq.com',
  '163.com', '126.com', 'yeah.net', 'sina.com', 'sohu.com',
  'aliyun.com',
]);

/**
 * 校验 admin_senders 配置合理性，启动时调用一次。
 * 返回警告字符串列表（空列表 = 配置 OK）。
 *
 * 检查规则：
 *   - 整个公共邮件域（@gmail.com）不应配为 admin —— 任何人都能下达指令
 *   - 单个公共域邮箱（admin@gmail.com）允许，但给出温和提示（运营者自己承担风险）
 *
 * @param {string[]} adminSenders
 * @returns {string[]}
 */
function validateAdminSenders(adminSenders) {
  const warnings = [];
  for (const raw of adminSenders || []) {
    const rule = String(raw).trim().toLowerCase();
    if (!rule) continue;
    if (rule.startsWith('@')) {
      const domain = rule.slice(1).replace(/^\*\./, '');
      if (PUBLIC_EMAIL_DOMAINS.has(domain)) {
        warnings.push(
          `admin_senders 包含公共邮件域 "${rule}" —— 这会让任意人能执行 admin 指令，请删除该项`,
        );
      }
    } else {
      const atIdx = rule.indexOf('@');
      if (atIdx !== -1) {
        const domain = rule.slice(atIdx + 1);
        if (PUBLIC_EMAIL_DOMAINS.has(domain)) {
          warnings.push(
            `admin_senders 含公共域邮箱 "${rule}" —— 确认这是受控账号，否则建议改用企业域`,
          );
        }
      }
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// AclConfig
// ---------------------------------------------------------------------------

class AclConfig {
  /**
   * @param {object} [opts]
   * @param {string} [opts.aclConfigFile]   Path to email-acl.yaml (or null to skip)
   * @param {string} [opts.dynamicFile]     Path to acl-dynamic.json
   */
  constructor(opts = {}) {
    this._aclConfigFile = opts.aclConfigFile || null;
    this._dynamicFile   = opts.dynamicFile || DEFAULT_DYNAMIC_FILE;
    this._static        = this._loadStatic(this._aclConfigFile);
    this._dynamic       = this._loadDynamic();
    this._merged        = this._merge();

    // 启动时校验 admin_senders 配置合理性（仅警告，不阻塞启动）
    for (const w of validateAdminSenders(this.adminSenders)) {
      process.stderr.write(`[acl-config] ⚠ ${w}\n`);
    }
  }

  /**
   * Hot-reload: 重新读取静态 yaml + 动态文件并原地合并。
   * 已持有的 AclConfig / SenderAcl / AdminHandler 引用通过 getter 实时读取，
   * 无需重建——下次 checkGlobal / isAdmin 即用新规则。
   */
  reload() {
    this._static  = this._loadStatic(this._aclConfigFile);
    this._dynamic = this._loadDynamic();
    this._merged  = this._merge();
    for (const w of validateAdminSenders(this.adminSenders)) {
      process.stderr.write(`[acl-config] ⚠ ${w}\n`);
    }
  }

  // ── public getters ────────────────────────────────────────────────────────

  get allowedSenders()        { return this._merged.allowed; }
  get deniedSenders()         { return this._merged.denied; }
  get adminSenders()          { return this._static.admin_senders || []; }
  get instantReplySenders()   { return this._static.instant_reply_senders || []; }
  get denyAction()            { return this._static.deny_action || 'silent'; }
  get denyMessage()           { return this._static.deny_message || null; }
  get profileAcl()            { return this._static.profile_acl || {}; }
  get reportConfig()          { return this._static.report || {}; }

  /** True when no ACL rules at all (open access mode). */
  isOpenAccess() {
    return this._merged.allowed.length === 0 &&
           this._merged.denied.length  === 0;
  }

  // ── dynamic mutations (runtime, persisted to JSON) ────────────────────────

  /**
   * Add addresses to the dynamic allowlist.
   * @param {string[]} addresses
   */
  dynamicAllow(addresses) {
    const d = this._loadDynamic();
    for (const addr of addresses) {
      const lower = addr.toLowerCase();
      if (!d.allowed.includes(lower)) d.allowed.push(lower);
      d.denied = d.denied.filter((a) => a !== lower);
    }
    this._saveDynamic(d);
    this._dynamic = d;
    this._merged  = this._merge();
  }

  /**
   * Add addresses to the dynamic denylist.
   * @param {string[]} addresses
   */
  dynamicDeny(addresses) {
    const d = this._loadDynamic();
    for (const addr of addresses) {
      const lower = addr.toLowerCase();
      if (!d.denied.includes(lower)) d.denied.push(lower);
      d.allowed = d.allowed.filter((a) => a !== lower);
    }
    this._saveDynamic(d);
    this._dynamic = d;
    this._merged  = this._merge();
  }

  /**
   * Remove addresses from both dynamic lists (reset to static-only behaviour).
   * @param {string[]} addresses
   */
  dynamicReset(addresses) {
    const d = this._loadDynamic();
    for (const addr of addresses) {
      const lower = addr.toLowerCase();
      d.allowed = d.allowed.filter((a) => a !== lower);
      d.denied  = d.denied.filter((a) => a !== lower);
    }
    this._saveDynamic(d);
    this._dynamic = d;
    this._merged  = this._merge();
  }

  /** Return a snapshot of the dynamic lists (for /status command). */
  dynamicSnapshot() {
    return { allowed: [...this._dynamic.allowed], denied: [...this._dynamic.denied] };
  }

  // ── private ───────────────────────────────────────────────────────────────

  _loadStatic(aclConfigFile) {
    if (!aclConfigFile) return {};
    try {
      return loadAclConfig(aclConfigFile);
    } catch (err) {
      process.stderr.write(`[acl-config] Cannot load ${aclConfigFile}: ${err.message}\n`);
      return {};
    }
  }

  _loadDynamic() {
    try {
      if (fs.existsSync(this._dynamicFile)) {
        const raw = JSON.parse(fs.readFileSync(this._dynamicFile, 'utf8'));
        return {
          allowed: Array.isArray(raw.allowed) ? raw.allowed : [],
          denied:  Array.isArray(raw.denied)  ? raw.denied  : [],
        };
      }
    } catch (err) {
      // 动态 ACL 损坏不能静默：相当于丢失运营指令历史
      process.stderr.write(`[acl-config] Cannot load dynamic ACL (${this._dynamicFile}): ${err.message}\n`);
    }
    return { allowed: [], denied: [] };
  }

  _saveDynamic(data) {
    // 原子写：先写临时文件再 rename，避免并发 admin 指令互相覆盖造成最后写入获胜
    const dir = path.dirname(this._dynamicFile);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `.acl-dynamic.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(
        tmp,
        JSON.stringify({ allowed: data.allowed, denied: data.denied }, null, 2),
        'utf8',
      );
      fs.renameSync(tmp, this._dynamicFile);
    } catch (err) {
      process.stderr.write(`[acl-config] Cannot save dynamic ACL: ${err.message}\n`);
    }
  }

  _merge() {
    const staticAllowed = this._static.allowed_senders || [];
    const staticDenied  = this._static.denied_senders  || [];
    const dynAllowed    = this._dynamic.allowed;
    const dynDenied     = this._dynamic.denied;

    // Dynamic allow entries override dynamic deny (already enforced in dynamicAllow/Deny)
    // but static deny is never overridden by dynamic allow — static config is authoritative
    const mergedAllowed = [...new Set([...staticAllowed, ...dynAllowed])];
    const mergedDenied  = [...new Set([...staticDenied,  ...dynDenied])];

    return { allowed: mergedAllowed, denied: mergedDenied };
  }
}

module.exports = { AclConfig };
