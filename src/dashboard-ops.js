'use strict';
/**
 * dashboard-ops.js — Dashboard 写操作辅助函数
 *
 * 提供 ACL 修改、Profile 增删、Pending 丢弃等操作。
 * 这些函数均为纯文件操作（不依赖 HTTP 层），可独立测试。
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { AclConfig }    = require('./acl-config');
const { PendingStore } = require('./pending-store');

// ---------------------------------------------------------------------------
// ACL 操作
// ---------------------------------------------------------------------------

/**
 * 对动态 ACL 执行 allow / deny / reset 操作。
 *
 * @param {string} action   'allow' | 'deny' | 'reset'
 * @param {string} address  邮箱地址或 @domain 规则
 * @param {object} [opts]
 * @param {string} [opts.storeDir]
 * @param {string} [opts.aclConfig]
 * @returns {{ ok: true } | { error: string }}
 */
function execAclMutation(action, address, opts = {}) {
  const storeDir = opts.storeDir || path.join(os.homedir(), '.agently-mail-client');
  const aclFile  = opts.aclConfig || (() => {
    const c = path.join(process.cwd(), 'email-acl.yaml');
    return fs.existsSync(c) ? c : null;
  })();
  try {
    const acl = new AclConfig({
      aclConfigFile: aclFile,
      dynamicFile:   path.join(storeDir, 'acl-dynamic.json'),
    });
    if (action === 'allow')       acl.dynamicAllow([address]);
    else if (action === 'deny')   acl.dynamicDeny([address]);
    else if (action === 'reset')  acl.dynamicReset([address]);
    else throw new Error(`Unknown action: ${action}`);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Pending 操作
// ---------------------------------------------------------------------------

/**
 * 丢弃一条待重试消息（标记为 replied，retry sweep 不再触发）。
 *
 * @param {string} messageId
 * @param {object} [opts]
 * @param {string} [opts.storeDir]
 * @returns {{ ok: true } | { error: string }}
 */
function discardPending(messageId, opts = {}) {
  const storeDir = opts.storeDir || path.join(os.homedir(), '.agently-mail-client');
  try {
    const store = new PendingStore(path.join(storeDir, 'pending.json'));
    store.markReplied(messageId);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Profile 操作
// ---------------------------------------------------------------------------

/**
 * 读取 email-profiles.yaml，返回 { config, yaml }。
 */
function _loadProfilesYaml(profilesFile) {
  const raw = fs.readFileSync(profilesFile, 'utf8');
  const yaml = require('js-yaml');
  return { config: yaml.load(raw) || {}, yaml };
}

/**
 * 新增或更新 Profile 到 email-profiles.yaml。
 *
 * @param {object} profileEntry  包含 name 及其余字段
 * @param {object} [opts]
 * @param {string} [opts.profilesConfig]
 * @returns {{ ok: true } | { error: string }}
 */
function saveProfileToYaml(profileEntry, opts = {}) {
  const profilesFile = opts.profilesConfig || path.join(process.cwd(), 'email-profiles.yaml');
  try {
    const { config, yaml } = _loadProfilesYaml(profilesFile);
    if (!config.profiles) config.profiles = {};
    const { name, ...rest } = profileEntry;
    config.profiles[name] = rest;
    const newYaml = yaml.dump(config, { lineWidth: 120, indent: 2 });
    const tmp = `${profilesFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, newYaml, 'utf8');
    fs.renameSync(tmp, profilesFile);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * 从 email-profiles.yaml 删除 Profile。
 *
 * @param {string} name
 * @param {object} [opts]
 * @param {string} [opts.profilesConfig]
 * @returns {{ ok: true } | { error: string }}
 */
function deleteProfileFromYaml(name, opts = {}) {
  const profilesFile = opts.profilesConfig || path.join(process.cwd(), 'email-profiles.yaml');
  try {
    const { config, yaml } = _loadProfilesYaml(profilesFile);
    if (!config.profiles || !config.profiles[name]) {
      return { error: `Profile "${name}" not found` };
    }
    if (config.default === name) {
      const remaining = Object.keys(config.profiles).filter((k) => k !== name);
      if (remaining.length === 0) {
        return { error: '无法删除唯一的默认 Profile，请先添加其他 Profile 再删除' };
      }
      config.default = remaining[0];
    }
    delete config.profiles[name];
    const newYaml = yaml.dump(config, { lineWidth: 120, indent: 2 });
    const tmp = `${profilesFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, newYaml, 'utf8');
    fs.renameSync(tmp, profilesFile);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = {
  execAclMutation,
  discardPending,
  saveProfileToYaml,
  deleteProfileFromYaml,
};
