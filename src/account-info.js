'use strict';
/**
 * account-info.js — 持久化账号信息到本地，供 bridge 与 dashboard 共享。
 *
 * 设计目的：重启时不再为了拿"自己的邮箱地址"而立刻打一次上游 +me。
 * bridge 在成功调用 me() 后把别名写到这里；dashboard 直接读这里，避免冷启动
 * 时被浏览器的 /api/me 请求拽去打上游。
 *
 * 文件：~/.agently-mail-client/account-info.json
 *   { aliases: [{email, ...}], email: "<primary>", fetchedAt: "<ISO>", pid: <n> }
 */

const fs = require('fs');
const path = require('path');

const FILENAME = 'account-info.json';

function filePath(storeDir) {
  return path.join(storeDir, FILENAME);
}

/**
 * 读取持久化的账号信息。
 * @param {string} storeDir
 * @returns {{aliases: object[], email: string, fetchedAt: string} | null}
 */
function readAccountInfo(storeDir) {
  try {
    const p = filePath(storeDir);
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!data || !Array.isArray(data.aliases)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * 从 me() 返回值提取并持久化账号信息。
 * @param {string} storeDir
 * @param {object} me  agently-cli +me 的返回（{ aliases: [{email, ...}] }）
 */
function writeAccountInfo(storeDir, me) {
  try {
    fs.mkdirSync(storeDir, { recursive: true });
    const payload = {
      aliases: Array.isArray(me?.aliases) ? me.aliases : [],
      email: me?.aliases?.[0]?.email || null,
      fetchedAt: new Date().toISOString(),
      pid: process.pid,
    };
    const tmp = `${filePath(storeDir)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, filePath(storeDir));
  } catch {
    /* best-effort */
  }
}

/**
 * 从持久化数据构造 own-address 集合（小写）。
 * @returns {Set<string>}
 */
function ownAddressesFrom(info) {
  const set = new Set();
  for (const alias of (info?.aliases || [])) {
    if (alias?.email) set.add(alias.email.toLowerCase());
  }
  return set;
}

module.exports = {
  ACCOUNT_INFO_FILE: FILENAME,
  accountInfoPath: filePath,
  readAccountInfo,
  writeAccountInfo,
  ownAddressesFrom,
};
