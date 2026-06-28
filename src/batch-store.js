'use strict';
/**
 * BatchStore — 批处理模式下的邮件队列持久化
 *
 * 在批处理模式下，通过 ACL 检查但不属于信任域的邮件不立即 dispatch，
 * 而是进入此队列等待主人决策。
 *
 * 状态流转：
 *   queued   → 等待主人指令
 *   replied  → Agent 已回复（主人指令 reply 后执行成功）
 *   skipped  → 主人指令跳过
 *   failed   → 执行失败（可重试）
 *
 * 存储路径：~/.agently-mail-client/batch-queue.json
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DEFAULT_STORE_DIR  = path.join(os.homedir(), '.agently-mail-client');
const DEFAULT_STORE_FILE = path.join(DEFAULT_STORE_DIR, 'batch-queue.json');

// 已处理条目保留 7 天后清理
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

class BatchStore {
  /**
   * @param {string} [storeFile]
   */
  constructor(storeFile = DEFAULT_STORE_FILE) {
    this.storeFile = storeFile;
    this._data = null;
  }

  _load() {
    if (this._data !== null) return;
    try {
      fs.mkdirSync(path.dirname(this.storeFile), { recursive: true });
      if (fs.existsSync(this.storeFile)) {
        const raw = JSON.parse(fs.readFileSync(this.storeFile, 'utf8'));
        // _meta is a reserved key for store-level metadata (not a message entry)
        this._meta = raw._meta || {};
        this._data = {};
        for (const [k, v] of Object.entries(raw)) {
          if (k !== '_meta') this._data[k] = v;
        }
      } else {
        this._data = {};
        this._meta = {};
      }
    } catch (err) {
      process.stderr.write(`[batch-store] Failed to load ${this.storeFile}: ${err.message}\n`);
      this._data = {};
      this._meta = {};
    }
  }

  _save() {
    const dir = path.dirname(this.storeFile);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `.batch-queue.${process.pid}.${Date.now()}.tmp`);
      // Persist _meta alongside message entries under the reserved '_meta' key
      const payload = { _meta: this._meta || {}, ...this._data };
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmp, this.storeFile);
    } catch (err) {
      process.stderr.write(`[batch-store] Failed to save: ${err.message}\n`);
    }
  }

  /**
   * Persist the timestamp of the last summary report so restarts don't re-report.
   * @param {string} isoTimestamp
   */
  setLastReportAt(isoTimestamp) {
    this._load();
    this._meta.lastReportAt = isoTimestamp;
    this._save();
  }

  /**
   * Return the persisted last-report timestamp, or null if never reported.
   * @returns {string|null}
   */
  getLastReportAt() {
    this._load();
    return this._meta.lastReportAt || null;
  }

  /**
   * 将邮件加入批处理队列（queued 状态）。
   * 已存在的 message_id 会被忽略（幂等）。
   *
   * @param {object} msgSummary  来自 poll 的邮件摘要（message_id, subject, from, created_at）
   * @param {string} [bodySnippet]  正文前 N 字（用于摘要邮件预览）
   */
  enqueue(msgSummary, bodySnippet = '') {
    this._load();
    const id = msgSummary.message_id;
    if (!id || this._data[id]) return;
    this._data[id] = {
      message_id:   id,
      subject:      msgSummary.subject || '',
      from_email:   msgSummary.from?.email || '',
      from_name:    msgSummary.from?.name  || '',
      created_at:   msgSummary.created_at  || new Date().toISOString(),
      queued_at:    new Date().toISOString(),
      body_snippet: bodySnippet,
      status:       'queued',
      resolved_at:  null,
      error:        null,
    };
    this._save();
  }

  /**
   * 标记为已回复。
   * @param {string} messageId
   */
  markReplied(messageId) {
    this._load();
    if (this._data[messageId]) {
      this._data[messageId].status      = 'replied';
      this._data[messageId].resolved_at = new Date().toISOString();
      this._save();
    }
  }

  /**
   * 标记为已跳过（主人决定不处理）。
   * @param {string} messageId
   */
  markSkipped(messageId) {
    this._load();
    if (this._data[messageId]) {
      this._data[messageId].status      = 'skipped';
      this._data[messageId].resolved_at = new Date().toISOString();
      this._save();
    }
  }

  /**
   * 标记为执行失败。
   * @param {string} messageId
   * @param {string} [errorMessage]
   */
  markFailed(messageId, errorMessage = '') {
    this._load();
    if (this._data[messageId]) {
      this._data[messageId].status = 'failed';
      this._data[messageId].error  = errorMessage;
      this._save();
    }
  }

  /**
   * 返回所有 queued 状态的条目（等待主人决策）。
   * @returns {object[]}
   */
  getQueued() {
    this._load();
    return Object.values(this._data).filter((e) => e.status === 'queued');
  }

  /**
   * 返回所有条目（用于构建摘要邮件的"已处理"部分）。
   * @param {object} [opts]
   * @param {string} [opts.since]  ISO 日期，只返回此时间之后的条目
   * @returns {object[]}
   */
  getAll(opts = {}) {
    this._load();
    let entries = Object.values(this._data);
    if (opts.since) {
      const sinceMs = new Date(opts.since).getTime();
      entries = entries.filter((e) => new Date(e.queued_at).getTime() >= sinceMs);
    }
    return entries;
  }

  /**
   * 根据 message_id 查找单条记录。
   * @param {string} messageId
   * @returns {object|null}
   */
  get(messageId) {
    this._load();
    return this._data[messageId] || null;
  }

  /**
   * 清理 7 天前已处理（replied/skipped）的条目。
   */
  cleanup() {
    this._load();
    const cutoff = Date.now() - RETENTION_MS;
    let changed = false;
    for (const [id, entry] of Object.entries(this._data)) {
      if (entry.status === 'replied' || entry.status === 'skipped') {
        if (entry.resolved_at && new Date(entry.resolved_at).getTime() < cutoff) {
          delete this._data[id];
          changed = true;
        }
      }
    }
    if (changed) this._save();
  }
}

module.exports = { BatchStore };
