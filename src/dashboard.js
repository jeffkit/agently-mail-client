'use strict';
/**
 * Dashboard HTTP Server — 本地只读管理面板
 *
 * 启动方式：agently-mail dashboard [--port 3030] [--host 127.0.0.1]
 *
 * 提供：
 *   GET /          → 单页 HTML 面板
 *   GET /api/state → JSON 状态快照（面板 Ajax 轮询用）
 *
 * 只读：所有管理操作仍通过管理员邮件指令完成。
 * 仅监听 127.0.0.1，不对外网暴露。
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

const { MailArchive, computeThreadRoot } = require('./mail-archive');
const { readState }  = require('./dashboard-state');
const {
  execAclMutation,
  discardPending,
  saveProfileToYaml,
  deleteProfileFromYaml,
} = require('./dashboard-ops');

// ── Write API helpers ─────────────────────────────────────────────────────────

/**
 * Parse a JSON body from an incoming request.
 * @param {http.IncomingMessage} req
 * @returns {Promise<object>}
 */
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

/**
 * 启动 Dashboard HTTP 服务。
 *
 * Read API:
 *   GET /          → HTML 面板
 *   GET /api/state → JSON 状态快照（面板 Ajax 轮询用）
 *
 * Write API（需 JSON body）:
 *   POST /api/acl       { action: 'allow'|'deny'|'reset', address: string }
 *   POST /api/pending   { action: 'discard', message_id: string }
 *   POST /api/send      { to, cc, bcc, subject, body, bodyFormat }   发新邮件
 *   POST /api/reply     { message_id, body, replyAll, cc }            回复
 *   POST /api/forward   { message_id, to, body }                      转发
 *   DELETE /api/profiles/:name
 *
 * Mail archive API（inbox / thread 视图）:
 *   GET /api/messages?dir=all|in|out&view=thread|message&limit=&offset=&q=
 *   GET /api/message/:id        归档命中直接返回；未命中 live +read 一次并回写
 *   GET /api/thread/:threadRoot 返回该 thread 的全部来往记录（按时间正序）
 *
 * @param {object} [opts]
 * @param {number} [opts.port=3030]
 * @param {string} [opts.host='127.0.0.1']
 * @param {string} [opts.profilesConfig]
 * @param {string} [opts.aclConfig]
 * @param {string} [opts.storeDir]
 * @param {boolean} [opts.open=true]   自动打开浏览器
 * @returns {{ server: http.Server, stop: () => void }}
 */
// ── Dashboard token (CSRF protection) ────────────────────────────────────────

/**
 * 生成或读取持久化 dashboard token。
 * Token 保存在 storeDir/dashboard.token（权限 0o600），进程重启后维持不变。
 * 所有写 API 要求请求头 X-Dashboard-Token 与此 token 一致。
 */
function getOrCreateToken(storeDir) {
  fs.mkdirSync(storeDir, { recursive: true });
  const tokenFile = path.join(storeDir, 'dashboard.token');
  if (fs.existsSync(tokenFile)) {
    const t = fs.readFileSync(tokenFile, 'utf8').trim();
    if (t.length >= 32) return t;
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  return token;
}

// Determine the static frontend dist directory (built React app)
const DIST_DIR = path.resolve(__dirname, 'dashboard-dist');

// Lazily-loaded and cached account info (calls agently-cli +me once per process).
// TTL of 5 minutes so account switches after `agently-cli auth login` are picked up.
const ME_CACHE_TTL_MS = 5 * 60 * 1000;
let _meCache = null;
let _meCacheAt = 0;
let _accountStoreDir = path.join(os.homedir(), '.agently-mail-client');
const { readAccountInfo, writeAccountInfo } = require('./account-info');

/**
 * 账号信息优先走本地 account-info.json（由 bridge 维护），dashboard 不主动打上游。
 * 仅当本地缓存不存在时，才回退到一次 client.me() 并落盘。
 * 进程内 5 分钟缓存作为二级缓存，避免反复读盘。
 */
async function getAccountInfo() {
  if (_meCache && Date.now() - _meCacheAt < ME_CACHE_TTL_MS) return _meCache;

  // 1) 本地磁盘缓存（bridge 写入）
  const disk = readAccountInfo(_accountStoreDir);
  if (disk) {
    _meCache = disk;
    _meCacheAt = Date.now();
    return disk;
  }

  // 2) 无磁盘缓存：回退打一次上游（首次/bridge 未运行过），成功则落盘供后续复用
  try {
    const { AgentlyMailClient } = require('./agently-mail');
    const client = new AgentlyMailClient();
    const info = await client.me();
    writeAccountInfo(_accountStoreDir, info);
    _meCache = info;
    _meCacheAt = Date.now();
    return info;
  } catch {
    return _meCache || null; // return stale on error rather than null
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
};

// Lazily-loaded, shared mail client + archive (dashboard process scope).
// The mail client carries its own in-process RPM token bucket; since the bridge
// runs in a separate process, we additionally consult the bridge-persisted
// rpm-stats.json before any live CLI call to avoid combined bursts past the
// 10 req/min server cap.
let _mailClient = null;
function getMailClient() {
  if (!_mailClient) {
    const { AgentlyMailClient } = require('./agently-mail');
    _mailClient = new AgentlyMailClient();
  }
  return _mailClient;
}

function getArchive(opts = {}) {
  const storeDir = opts.storeDir || path.join(os.homedir(), '.agently-mail-client');
  return new MailArchive(path.join(storeDir, 'mail-archive.jsonl'));
}

/**
 * Consult the bridge's persisted RPM stats. Returns true if a live CLI call
 * is safe (at least `need` tokens likely available). Best-effort: if the stats
 * file is missing/stale, allow the call (the in-process limiter still applies).
 *
 * @param {number} [need=1]
 * @param {object} [opts]
 * @returns {boolean}
 */
function rpmBudgetAvailable(need = 1, opts = {}) {
  const storeDir = opts.storeDir || path.join(os.homedir(), '.agently-mail-client');
  try {
    const file = path.join(storeDir, 'rpm-stats.json');
    if (!fs.existsSync(file)) return true;
    const stats = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!stats || stats.enabled === false) return true;
    const updated = stats.updatedAt ? new Date(stats.updatedAt).getTime() : 0;
    // stats older than 60s → window has rolled over, treat as fresh
    if (Date.now() - updated > 60_000) return true;
    return (stats.available ?? 0) >= need;
  } catch {
    return true;
  }
}

/** Format an email address array for the archive record. */
function normalizeRecipients(val) {
  if (!val) return null;
  const arr = Array.isArray(val) ? val : String(val).split(',').map((s) => s.trim()).filter(Boolean);
  return arr.map((a) => (typeof a === 'string' ? { email: a } : a));
}

function serveStatic(urlPath, res, token = '') {
  // Security: decode the URL and use path.resolve to canonicalize, then verify
  // the result is inside DIST_DIR. String replace of ".." is insufficient
  // because percent-encoded variants (%2e%2e) bypass naive string checks.
  const decoded = decodeURIComponent((urlPath || '/').split('?')[0]);
  const candidate = path.resolve(DIST_DIR, '.' + decoded);
  const indexHtml = path.join(DIST_DIR, 'index.html');
  // Fallback to index.html for SPA routing (non-existent paths or directories)
  let target = candidate;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    target = indexHtml;
  }
  // Enforce DIST_DIR boundary after resolving symlinks / . and ..
  if (target !== indexHtml && !target.startsWith(DIST_DIR + path.sep)) {
    res.writeHead(403); res.end(); return;
  }
  try {
    const ext = path.extname(target);
    if (target.endsWith('index.html') && token) {
      // 将 token 注入 HTML，React 应用通过 window.__DASHBOARD_TOKEN__ 读取后
      // 随写操作附带 X-Dashboard-Token 请求头，防止 CSRF。
      let html = fs.readFileSync(target, 'utf8');
      const injection = `<script>window.__DASHBOARD_TOKEN__=${JSON.stringify(token)}</script>`;
      html = html.includes('</head>')
        ? html.replace('</head>', injection + '</head>')
        : injection + html;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      const mime = MIME[ext] || 'application/octet-stream';
      const content = fs.readFileSync(target);
      res.writeHead(200, { 'Content-Type': mime });
      res.end(content);
    }
  } catch {
    res.writeHead(404); res.end('Not Found');
  }
}

function startDashboard(opts = {}) {
  const port = opts.port || 3030;
  const host = opts.host || '127.0.0.1';

  const storeDir = opts.storeDir || path.join(os.homedir(), '.agently-mail-client');
  _accountStoreDir = storeDir;
  const token = getOrCreateToken(storeDir);

  const server = http.createServer(async (req, res) => {
    // 不设置 Access-Control-Allow-Origin: * —— 避免恶意网页通过 CSRF 调用写 API。
    // Dashboard 仅供本机浏览器使用，同源请求无需 CORS 头。
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── GET endpoints ──
    if (req.method === 'GET') {
      if (req.url === '/api/state' || req.url?.startsWith('/api/state?')) {
        try {
          const state = readState(opts);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(state));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }
      if (req.url === '/api/me') {
        const info = await getAccountInfo();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(info || {}));
        return;
      }
      // ── Inbox / thread (mail archive) ──
      if (req.url?.startsWith('/api/messages')) {
        try {
          const u = new URL(req.url, 'http://localhost');
          const dir = u.searchParams.get('dir') || 'all'; // all|in|out
          const limit = parseInt(u.searchParams.get('limit') || '50', 10);
          const offset = parseInt(u.searchParams.get('offset') || '0', 10);
          const q = u.searchParams.get('q') || '';
          const view = u.searchParams.get('view') || 'thread'; // thread|message
          const archive = getArchive(opts);
          const data = view === 'message'
            ? archive.list({ direction: dir, limit, offset, q })
            : archive.listThreads({ direction: dir, limit, q });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ items: data, total: archive.size() }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }
      let m = req.url?.match(/^\/api\/message\/([^/]+)$/);
      if (m) {
        try {
          const id = decodeURIComponent(m[1]);
          const archive = getArchive(opts);
          let rec = archive.getByMessageId(id);
          if (!rec) {
            // 未归档：live +read 一次并回写（消耗 1 个 RPM 配额）
            if (!rpmBudgetAvailable(1, opts)) {
              res.writeHead(429, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'API 配额紧张，请稍后再试' }));
              return;
            }
            const fullMsg = await getMailClient().read(id);
            archive.archiveIncoming(fullMsg);
            rec = archive.getByMessageId(id);
          }
          if (!rec) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(rec));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }
      m = req.url?.match(/^\/api\/thread\/(.+)$/);
      if (m) {
        try {
          const root = decodeURIComponent(m[1]);
          const archive = getArchive(opts);
          const items = archive.getThread(root);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ thread_root: root, items }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }
      // Static files (React SPA)
      serveStatic(req.url, res, token);
      return;
    }

    // ── 写 API 统一 token 校验 ──────────────────────────────────────────────────
    // 所有 POST / DELETE 请求必须携带 X-Dashboard-Token 头。
    // React 应用从 window.__DASHBOARD_TOKEN__（注入 index.html）读取 token。
    if (req.method === 'POST' || req.method === 'DELETE') {
      const provided = req.headers['x-dashboard-token'] || '';
      const a = Buffer.from(provided);
      const b = Buffer.from(token);
      const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (!valid) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '未授权：缺少或无效的 X-Dashboard-Token 请求头' }));
        return;
      }
    }

    // ── POST endpoints (write API) ──
    if (req.method === 'POST') {
      let body;
      try { body = await parseJsonBody(req); }
      catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
        return;
      }

      if (req.url === '/api/acl') {
        const { action, address } = body;
        if (!action || !address) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'action and address required' }));
          return;
        }
        const result = execAclMutation(action, address, opts);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.url === '/api/profiles') {
        const { name, ...rest } = body;
        if (!name || !rest.command) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'name and command required' }));
          return;
        }
        const result = saveProfileToYaml({ name, ...rest }, opts);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.url === '/api/pending') {
        const { action, message_id } = body;
        if (action === 'discard' && message_id) {
          const result = discardPending(message_id, opts);
          res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'action=discard and message_id required' }));
        return;
      }

      // ── 同步历史邮件到归档（backfill）──────────────────────────────────────
      // source='pending': 从 pending.json 取已知 message_id 逐封 live +read 回填（incoming）
      // source='inbox':   从服务器 +list(inbox) 拉最近摘要，未归档的逐封 +read 回填（incoming）
      // source='sent':    从服务器 +list(sent) 拉最近摘要，未归档的逐封 +read 回填（outgoing，
      //                    按 references/in_reply_to 计算 thread_root，自动并入对应会话）
      // 每次 live read 受 in-process RPM 节流（≤8/min），单次请求上限 limit（默认 8）
      // 以免长时间挂起。前端可重复调用直到 remaining=0。
      if (req.url === '/api/sync') {
        const source = body.source || 'pending';
        const limit = Math.min(parseInt(body.limit || '8', 10), 8);
        const direction = source === 'sent' ? 'out' : 'in';
        try {
          const archive = getArchive(opts);
          const client = getMailClient();
          const ids = [];
          if (source === 'pending') {
            const storeDir = opts.storeDir || path.join(os.homedir(), '.agently-mail-client');
            const raw = fs.existsSync(path.join(storeDir, 'pending.json'))
              ? JSON.parse(fs.readFileSync(path.join(storeDir, 'pending.json'), 'utf8'))
              : {};
            for (const e of Object.values(raw)) {
              if (e.message_id && !archive.getByMessageId(e.message_id)) ids.push(e.message_id);
            }
          } else if (source === 'inbox' || source === 'sent') {
            if (!rpmBudgetAvailable(1, opts)) {
              res.writeHead(429, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'API 配额紧张，请稍后再试' }));
              return;
            }
            const { messages } = await client.list({ dir: source, limit: 30 });
            for (const m of messages || []) {
              if (m.message_id && !archive.getByMessageId(m.message_id)) ids.push(m.message_id);
            }
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "source must be 'pending', 'inbox' or 'sent'" }));
            return;
          }

          const toFetch = ids.slice(0, limit);
          const remaining = ids.length - toFetch.length;
          let archived = 0;
          const failed = [];
          for (let i = 0; i < toFetch.length; i++) {
            const id = toFetch[i];
            if (!rpmBudgetAvailable(1, opts)) {
              // 配额用完：剩余留到下次
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                ok: true, source, archived, failed,
                fetched: i, remaining: remaining + (toFetch.length - i),
                quotaExhausted: true,
              }));
              return;
            }
            try {
              const fullMsg = await client.read(id);
              if (direction === 'out') {
                if (archive.archiveOutgoing({
                  message_id: fullMsg.message_id || id,
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
                  source: 'bridge',
                })) archived++;
              } else {
                if (archive.archiveIncoming(fullMsg)) archived++;
              }
            } catch (err) {
              failed.push({ id, error: err.message });
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, source, archived, failed, fetched: toFetch.length, remaining }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }


      // ── Compose: send / reply / forward ──
      // 这些操作会真实发出邮件并消耗 RPM 配额。RPM 预检不通过时返回 429。
      if (req.url === '/api/send') {
        const { to, cc, bcc, subject, body: mailBody, bodyFormat } = body;
        if (!to || !subject || mailBody == null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'to, subject, body required' }));
          return;
        }
        if (!rpmBudgetAvailable(2, opts)) {  // two-phase send = 2 CLI calls
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'API 配额紧张，请稍后再试' }));
          return;
        }
        try {
          const opts2 = {};
          if (cc) opts2.cc = cc;
          if (bcc) opts2.bcc = bcc;
          if (bodyFormat === 'html') opts2.bodyFormat = 'html';
          const client = getMailClient();
          const result = await client.send(to, subject, mailBody, opts2);
          // 归档发件（thread_root 用合成值：新发件无引用，独立成 thread）
          try {
            const archive = getArchive(opts);
            const sentAt = new Date().toISOString();
            archive.archiveOutgoing({
              message_id: result?.message_id || result?.id || null,
              thread_root: result?.rfc_message_id || `<dashboard-send-${Date.now()}@local>`,
              to: normalizeRecipients(to),
              cc: normalizeRecipients(cc),
              subject,
              body_html: bodyFormat === 'html' ? mailBody : null,
              body_text: bodyFormat === 'html' ? null : mailBody,
              source: 'dashboard',
              sent_at: sentAt,
            });
          } catch (err) {
            process.stderr.write(`[dashboard] archive send failed: ${err.message}\n`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (req.url === '/api/reply') {
        const { message_id, body: mailBody, replyAll, cc } = body;
        if (!message_id || mailBody == null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'message_id and body required' }));
          return;
        }
        if (!rpmBudgetAvailable(2, opts)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'API 配额紧张，请稍后再试' }));
          return;
        }
        try {
          const archive = getArchive(opts);
          // 归档里若有原邮件则取来用于 thread 归组；否则尝试 live read（再耗 1 配额）
          let original = archive.getByMessageId(message_id);
          if (!original && rpmBudgetAvailable(1, opts)) {
            try {
              const fullMsg = await getMailClient().read(message_id);
              archive.archiveIncoming(fullMsg);
              original = archive.getByMessageId(message_id);
            } catch (err) {
              process.stderr.write(`[dashboard] reply: read original failed: ${err.message}\n`);
            }
          }
          const opts2 = { bodyFormat: 'html' };
          if (replyAll) opts2.replyAll = true;
          if (cc) opts2.cc = cc;
          const htmlBody = mailBody; // 前端已渲染 HTML
          const client = getMailClient();
          const result = await client.reply(message_id, htmlBody, opts2);
          try {
            archive.archiveOutgoing({
              message_id: result?.message_id || result?.id || null,
              thread_root: original?.thread_root || computeThreadRoot(original || { message_id }),
              in_reply_to: original?.rfc_message_id || original?.message_id || null,
              to: original?.from ? [original.from] : null,
              cc: normalizeRecipients(cc) || original?.cc || null,
              subject: original?.subject || '',
              body_html: htmlBody,
              references: original?.references || null,
              source: 'dashboard',
            });
          } catch (err) {
            process.stderr.write(`[dashboard] archive reply failed: ${err.message}\n`);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (req.url === '/api/forward') {
        const { message_id, to, body: mailBody } = body;
        if (!message_id || !to) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'message_id and to required' }));
          return;
        }
        if (!rpmBudgetAvailable(2, opts)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'API 配额紧张，请稍后再试' }));
          return;
        }
        try {
          const client = getMailClient();
          const result = await client.forward(message_id, to, mailBody || '', { bodyFormat: 'html' });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // ── DELETE endpoints ──
    if (req.method === 'DELETE') {
      const m = req.url.match(/^\/api\/profiles\/(.+)$/);
      if (m) {
        const name = decodeURIComponent(m[1]);
        const result = deleteProfileFromYaml(name, opts);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    res.writeHead(405);
    res.end('Method Not Allowed');
  });

  // Warm up the me-cache in the background so the first /api/me request is instant.
  getAccountInfo().catch(() => {});

  server.listen(port, host, () => {
    const url = `http://${host}:${port}`;
    process.stderr.write(`[dashboard] 管理面板已启动: ${url}\n`);
    const isLocalhost = ['127.0.0.1', '::1', 'localhost'].includes(host);
    if (!isLocalhost) {
      process.stderr.write(`[dashboard] ⚠️  安全警告：绑定到非 localhost 地址 ${host}\n`);
      process.stderr.write(`[dashboard] ⚠️  Dashboard 无外部鉴权，局域网内任何人均可发邮件、修改 ACL！\n`);
      process.stderr.write(`[dashboard] ⚠️  如需远程访问，请使用 SSH 隧道：ssh -L ${port}:127.0.0.1:${port} your-server\n`);
    }
    process.stderr.write(`[dashboard] Token 已就绪（写操作受 X-Dashboard-Token 保护）\n`);
    if (opts.open !== false) {
      _openBrowser(url);
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`[dashboard] 端口 ${port} 已被占用，请用 --port 指定其他端口\n`);
    } else {
      process.stderr.write(`[dashboard] 服务器错误: ${err.message}\n`);
    }
    process.exit(1);
  });

  return {
    server,
    stop() { server.close(); },
  };
}

function _openBrowser(url) {
  const { spawn } = require('child_process');
  const cmd = process.platform === 'win32' ? 'start'
    : process.platform === 'darwin'        ? 'open'
    : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // 打开浏览器失败不影响服务
  }
}

module.exports = { startDashboard, readState };
