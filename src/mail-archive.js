'use strict';
/**
 * MailArchive — 本地邮件归档存储（inbox / thread 视图的数据源）
 *
 * 解决的问题：
 *   管理台需要"收件箱"和"会话 thread"视图，但 bridge 原本只落盘了邮件元数据
 *   （pending.json），正文每次都要 live 拉取，受 10 req/min 配额约束，无法支撑
 *   浏览式查看。MailArchive 在 bridge 收发邮件时顺带把完整正文落盘，dashboard
 *   优先读归档，仅未命中时才 live `+read` 一次并回写。
 *
 * 存储格式（~/.agently-mail-client/mail-archive.jsonl）：
 *   每行一条 JSON 记录，append-only。direction=in 为收件，direction=out 为发件。
 *   以 (direction + message_id) 去重；outgoing 无 message_id 时以
 *   (thread_root + sent_at) 作为去重键。
 *
 * thread 归组：
 *   thread_root = references[0] || in_reply_to || rfc_message_id || message_id
 *   （与 dispatcher._sessionId 同源，但不做 hash、不带 profile，因为 inbox 要
 *    跨 profile 看完整会话）。outgoing 的 thread_root 从触发它的 incoming 继承。
 *
 * 写入是 best-effort：所有方法吞掉 IO 异常并记 stderr，绝不抛出——归档失败不能
 * 影响邮件收发主流程。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_STORE_DIR = path.join(os.homedir(), '.agently-mail-client');
const DEFAULT_ARCHIVE_FILE = path.join(DEFAULT_STORE_DIR, 'mail-archive.jsonl');

/**
 * Compute the raw thread root for a message (no hashing).
 * @param {object} msg
 * @returns {string}
 */
function computeThreadRoot(msg) {
  return (
    (Array.isArray(msg.references) && msg.references.length > 0
      ? msg.references[0]
      : null) ||
    msg.in_reply_to ||
    msg.rfc_message_id ||
    msg.message_id ||
    ''
  );
}

// Maximum number of records held in memory. Older records beyond this limit
// are evicted from the in-process index (they remain on disk). This caps
// memory usage as the JSONL file grows over time; a future SQLite migration
// would lift this restriction cleanly.
const MAX_RECORDS_IN_MEMORY = 5000;

class MailArchive {
  /**
   * @param {string} [archiveFile]  自定义归档文件路径
   */
  constructor(archiveFile = DEFAULT_ARCHIVE_FILE) {
    this.archiveFile = archiveFile;
    this._loaded = false;
    this._records = [];          // 所有记录（保持写入顺序，上限 MAX_RECORDS_IN_MEMORY）
    this._byMessageId = new Map(); // direction|message_id → record
    this._byThread = new Map();    // thread_root → record[]
  }

  // -------------------------------------------------------------------------
  // Private: lazy load + index
  // -------------------------------------------------------------------------

  _load() {
    if (this._loaded) return;
    this._loaded = true;
    try {
      fs.mkdirSync(path.dirname(this.archiveFile), { recursive: true });
      if (!fs.existsSync(this.archiveFile)) return;
      const raw = fs.readFileSync(this.archiveFile, 'utf8');
      const lines = raw.split('\n');
      // Parse all lines but only index the most recent MAX_RECORDS_IN_MEMORY to cap memory.
      // Older records stay on disk and can be retrieved by re-reading the file if needed.
      const parsed = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { parsed.push(JSON.parse(trimmed)); } catch { /* skip malformed lines */ }
      }
      const toIndex = parsed.length > MAX_RECORDS_IN_MEMORY
        ? parsed.slice(parsed.length - MAX_RECORDS_IN_MEMORY)
        : parsed;
      for (const rec of toIndex) {
        this._index(rec);
      }
    } catch (err) {
      process.stderr.write(`[mail-archive] Failed to load ${this.archiveFile}: ${err.message}\n`);
    }
  }

  _index(rec) {
    this._records.push(rec);
    const dedupKey = this._dedupKey(rec);
    if (dedupKey) this._byMessageId.set(dedupKey, rec);
    const root = rec.thread_root || computeThreadRoot(rec);
    if (root) {
      if (!this._byThread.has(root)) this._byThread.set(root, []);
      this._byThread.get(root).push(rec);
    }
  }

  _dedupKey(rec) {
    if (rec.message_id) return `${rec.direction}|${rec.message_id}`;
    if (rec.direction === 'out' && rec.thread_root && rec.sent_at) {
      return `out|${rec.thread_root}|${rec.sent_at}`;
    }
    return '';
  }

  _append(rec) {
    try {
      fs.mkdirSync(path.dirname(this.archiveFile), { recursive: true });
      fs.appendFileSync(this.archiveFile, JSON.stringify(rec) + '\n', { encoding: 'utf8' });
    } catch (err) {
      process.stderr.write(`[mail-archive] Failed to append: ${err.message}\n`);
    }
  }

  // -------------------------------------------------------------------------
  // Public API: writes
  // -------------------------------------------------------------------------

  /**
   * 归档一封收件（bridge read() 成功后调用）。
   * 重复写入会跳过。
   * @param {object} fullMsg  AgentlyMailClient.read() 的完整返回
   * @returns {boolean} 是否实际写入（false = 已存在或失败）
   */
  archiveIncoming(fullMsg) {
    if (!fullMsg || !fullMsg.message_id) return false;
    this._load();
    const key = `in|${fullMsg.message_id}`;
    if (this._byMessageId.has(key)) return false;

    const rec = {
      direction: 'in',
      message_id: fullMsg.message_id,
      rfc_message_id: fullMsg.rfc_message_id || null,
      thread_root: computeThreadRoot(fullMsg),
      from: fullMsg.from || null,
      to: fullMsg.to || null,
      cc: fullMsg.cc || null,
      subject: fullMsg.subject || '',
      body_html: fullMsg.body_html || fullMsg.body || null,
      body_text: fullMsg.body_text || null,
      references: Array.isArray(fullMsg.references) ? fullMsg.references : null,
      in_reply_to: fullMsg.in_reply_to || null,
      created_at: fullMsg.created_at || fullMsg.date || null,
      archived_at: new Date().toISOString(),
      attachments: Array.isArray(fullMsg.attachments) ? fullMsg.attachments : null,
    };
    this._append(rec);
    this._index(rec);
    return true;
  }

  /**
   * 归档一封发件（bridge reply() 或 dashboard send() 成功后调用）。
   * @param {object} entry
   * @param {string} [entry.message_id]   send/reply 返回的 id（可能没有）
   * @param {string} [entry.thread_root]  继承自原邮件；新发件则为 rfc id 或合成
   * @param {string} [entry.in_reply_to]
   * @param {object} [entry.to]           收件人
   * @param {object} [entry.cc]
   * @param {string} [entry.subject]
   * @param {string} [entry.body_html]
   * @param {string} [entry.source]       'bridge' | 'dashboard'
   * @returns {boolean}
   */
  archiveOutgoing(entry = {}) {
    this._load();
    const sentAt = entry.sent_at || new Date().toISOString();
    const rec = {
      direction: 'out',
      message_id: entry.message_id || null,
      rfc_message_id: entry.rfc_message_id || null,
      thread_root: entry.thread_root || '',
      from: entry.from || null,
      to: entry.to || null,
      cc: entry.cc || null,
      subject: entry.subject || '',
      body_html: entry.body_html || entry.body || null,
      body_text: entry.body_text || null,
      references: entry.references || null,
      in_reply_to: entry.in_reply_to || null,
      created_at: entry.created_at || sentAt,
      sent_at: sentAt,
      archived_at: new Date().toISOString(),
      source: entry.source || 'bridge',
      attachments: Array.isArray(entry.attachments) ? entry.attachments : null,
    };
    const key = this._dedupKey(rec);
    if (key && this._byMessageId.has(key)) return false;
    this._append(rec);
    this._index(rec);
    return true;
  }

  // -------------------------------------------------------------------------
  // Public API: reads
  // -------------------------------------------------------------------------

  /**
   * 是否已归档某封收件。
   * @param {string} messageId
   * @returns {boolean}
   */
  hasIncoming(messageId) {
    this._load();
    return this._byMessageId.has(`in|${messageId}`);
  }

  /**
   * 按 message_id 取单条记录（任意方向）。
   * @param {string} messageId
   * @returns {object|null}
   */
  getByMessageId(messageId) {
    this._load();
    return this._byMessageId.get(`in|${messageId}`) || this._byMessageId.get(`out|${messageId}`) || null;
  }

  /**
   * 列出邮件，按 created_at 倒序。
   * @param {object} [opts]
   * @param {'in'|'out'|'all'} [opts.direction='all']
   * @param {number} [opts.limit=50]
   * @param {number} [opts.offset=0]
   * @param {string} [opts.q]  关键词（subject / from / to 模糊匹配）
   * @returns {object[]}
   */
  list(opts = {}) {
    this._load();
    const direction = opts.direction || 'all';
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const q = (opts.q || '').trim().toLowerCase();

    let rows = this._records;
    if (direction !== 'all') rows = rows.filter((r) => r.direction === direction);
    if (q) {
      rows = rows.filter((r) => {
        const subj = (r.subject || '').toLowerCase();
        const from = JSON.stringify(r.from || '').toLowerCase();
        const to = JSON.stringify(r.to || '').toLowerCase();
        return subj.includes(q) || from.includes(q) || to.includes(q);
      });
    }
    rows = rows.slice().sort((a, b) => {
      const ta = new Date(a.created_at || a.sent_at || 0).getTime();
      const tb = new Date(b.created_at || b.sent_at || 0).getTime();
      return tb - ta;
    });
    return rows.slice(offset, offset + limit);
  }

  /**
   * 取一个 thread 的所有记录，按时间正序。
   * @param {string} threadRoot
   * @returns {object[]}
   */
  getThread(threadRoot) {
    this._load();
    const rows = this._byThread.get(threadRoot) || [];
    return rows.slice().sort((a, b) => {
      const ta = new Date(a.created_at || a.sent_at || 0).getTime();
      const tb = new Date(b.created_at || b.sent_at || 0).getTime();
      return ta - tb;
    });
  }

  /**
   * 列出所有 thread root（去重），附带每 thread 的最新时间与邮件数，按最新时间倒序。
   * 用于 inbox 按 thread 聚合展示。
   * @param {object} [opts]
   * @param {'in'|'out'|'all'} [opts.direction='all']
   * @param {number} [opts.limit=50]
   * @param {string} [opts.q]
   * @returns {{ thread_root: string, subject: string, last_at: string, count: number, last_from: object|null, unread: number }[]}
   */
  listThreads(opts = {}) {
    this._load();
    const direction = opts.direction || 'all';
    const limit = opts.limit ?? 50;
    const q = (opts.q || '').trim().toLowerCase();

    const out = [];
    for (const [root, rows] of this._byThread.entries()) {
      let filtered = rows;
      if (direction !== 'all') filtered = filtered.filter((r) => r.direction === direction);
      if (filtered.length === 0) continue;
      if (q) {
        const hit = filtered.some((r) => {
          const subj = (r.subject || '').toLowerCase();
          const from = JSON.stringify(r.from || '').toLowerCase();
          return subj.includes(q) || from.includes(q);
        });
        if (!hit) continue;
      }
      filtered = filtered.slice().sort((a, b) => {
        const ta = new Date(a.created_at || a.sent_at || 0).getTime();
        const tb = new Date(b.created_at || b.sent_at || 0).getTime();
        return ta - tb;
      });
      const last = filtered[filtered.length - 1];
      const first = filtered[0];
      out.push({
        thread_root: root,
        subject: first.subject || last.subject || '',
        last_at: last.created_at || last.sent_at || '',
        count: filtered.length,
        last_from: last.direction === 'in' ? last.from : null,
        last_to: last.direction === 'out' ? last.to : null,
        last_body_html: last.body_html || last.body_text || null,
        incoming_count: filtered.filter((r) => r.direction === 'in').length,
      });
    }
    out.sort((a, b) => new Date(b.last_at).getTime() - new Date(a.last_at).getTime());
    return out.slice(0, limit);
  }

  /**
   * 已归档记录总数。
   * @returns {number}
   */
  size() {
    this._load();
    return this._records.length;
  }
}

module.exports = { MailArchive, computeThreadRoot };
