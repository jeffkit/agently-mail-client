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

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

const { AclConfig }   = require('./acl-config');
const { BatchStore }  = require('./batch-store');
const { PendingStore } = require('./pending-store');
const { DeniedLog }   = require('./denied-log');
const { loadProfilesConfig } = require('./yaml-loader');

// ── State reader ──────────────────────────────────────────────────────────────

/**
 * 读取本地所有状态文件，返回面板需要的 JSON 快照。
 * 每次 /api/state 请求都重新从磁盘读（数据量小，无需缓存）。
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
  let pending = { queued: 0, entries: [] };
  try {
    const store = new PendingStore(path.join(storeDir, 'pending.json'));
    const all = store.getPending ? store.getPending() : [];
    // 也读取近期已回复的（用于历史记录）
    const raw = fs.existsSync(path.join(storeDir, 'pending.json'))
      ? JSON.parse(fs.readFileSync(path.join(storeDir, 'pending.json'), 'utf8'))
      : {};
    const entries = Object.values(raw)
      .sort((a, b) => new Date(b.added_at) - new Date(a.added_at))
      .slice(0, 100);
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

  return {
    timestamp: new Date().toISOString(),
    lastPollAt,
    profiles: Object.entries(profiles).map(([name, cfg]) => ({
      name,
      trigger:      cfg.trigger || name,
      description:  cfg.description || '',
      command:      cfg.command,
      args:         cfg.args || [],
      workdir:      cfg.workdir || null,
      timeout_ms:   cfg.timeout_ms || null,
      system_prompt: cfg.system_prompt || null,
      isDefault:    name === defaultProfile,
    })),
    acl: { static: aclStatic, dynamic: aclDynamic },
    pending,
    batch,
    denied,
  };
}

// ── HTML 面板 ─────────────────────────────────────────────────────────────────

function buildHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agently Mail · 管理面板</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #f5f5f5; --card: #fff; --border: #e0e0e0;
    --accent: #4f46e5; --accent-light: #eef2ff;
    --text: #1a1a1a; --muted: #6b7280;
    --green: #059669; --red: #dc2626; --yellow: #d97706; --blue: #2563eb;
  }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: var(--bg); color: var(--text); font-size: 14px; line-height: 1.5; }
  header { background: var(--accent); color: #fff; padding: 0 24px;
           display: flex; align-items: center; height: 52px; gap: 12px; }
  header h1 { font-size: 18px; font-weight: 600; }
  header .badge { font-size: 11px; background: rgba(255,255,255,.2);
                  padding: 2px 8px; border-radius: 99px; }
  #last-updated { margin-left: auto; font-size: 12px; opacity: .7; }
  main { max-width: 1100px; margin: 24px auto; padding: 0 16px;
         display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 760px) { main { grid-template-columns: 1fr; } }
  .card { background: var(--card); border: 1px solid var(--border);
          border-radius: 10px; overflow: hidden; }
  .card-full { grid-column: 1 / -1; }
  .card-header { padding: 14px 18px; border-bottom: 1px solid var(--border);
                 display: flex; align-items: center; gap: 8px; }
  .card-header h2 { font-size: 14px; font-weight: 600; }
  .card-header .count { margin-left: auto; font-size: 12px; color: var(--muted); }
  .card-body { padding: 14px 18px; }
  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .stat { background: var(--accent-light); border-radius: 8px; padding: 12px 14px; }
  .stat .val { font-size: 24px; font-weight: 700; color: var(--accent); }
  .stat .lbl { font-size: 12px; color: var(--muted); margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 10px; color: var(--muted);
       font-weight: 500; border-bottom: 1px solid var(--border); background: #fafafa; }
  td { padding: 8px 10px; border-bottom: 1px solid var(--border); }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #fafafa; }
  .tag { display: inline-block; padding: 1px 7px; border-radius: 99px;
         font-size: 11px; font-weight: 500; }
  .tag-green  { background: #d1fae5; color: var(--green); }
  .tag-red    { background: #fee2e2; color: var(--red); }
  .tag-yellow { background: #fef3c7; color: var(--yellow); }
  .tag-blue   { background: #dbeafe; color: var(--blue); }
  .tag-gray   { background: #f3f4f6; color: var(--muted); }
  .chip { display: inline-block; padding: 2px 10px; border-radius: 99px;
          font-size: 12px; background: var(--accent-light); color: var(--accent);
          margin: 2px 3px 2px 0; }
  .empty { color: var(--muted); font-size: 13px; padding: 12px 0; text-align: center; }
  .section-label { font-size: 12px; font-weight: 600; color: var(--muted);
                   text-transform: uppercase; letter-spacing: .05em; margin: 14px 0 6px; }
  .section-label:first-child { margin-top: 0; }
  .btn { padding: 6px 14px; border: none; border-radius: 6px; font-size: 13px;
         font-weight: 500; cursor: pointer; transition: opacity .15s; }
  .btn:hover { opacity: .85; }
  .btn-green { background: #d1fae5; color: var(--green); }
  .btn-red   { background: #fee2e2; color: var(--red); }
  .btn-gray  { background: #f3f4f6; color: var(--muted); }
  .btn-icon  { padding: 3px 8px; font-size: 11px; border-radius: 4px; }
  .input-field { width:100%;padding:7px 10px;border:1px solid var(--border);
                 border-radius:6px;font-size:13px;outline:none;box-sizing:border-box; }
  .input-field:focus { border-color:var(--accent); }
</style>
</head>
<body>
<header>
  <span style="font-size:22px">📬</span>
  <h1>Agently Mail</h1>
  <span class="badge">管理面板</span>
  <span id="last-updated">加载中…</span>
</header>

<main>
  <!-- 概览 -->
  <div class="card card-full">
    <div class="card-header"><h2>📊 概览</h2></div>
    <div class="card-body">
      <div class="stat-grid" id="stats">
        <div class="stat"><div class="val" id="s-profiles">-</div><div class="lbl">已加载 Profile</div></div>
        <div class="stat"><div class="val" id="s-pending">-</div><div class="lbl">待重试邮件</div></div>
        <div class="stat"><div class="val" id="s-batch">-</div><div class="lbl">批处理队列</div></div>
        <div class="stat"><div class="val" id="s-denied">-</div><div class="lbl">未上报拦截</div></div>
      </div>
      <div style="margin-top:12px; font-size:13px; color:var(--muted)">
        最近 poll 游标：<span id="last-poll" style="font-family:monospace">-</span>
      </div>
    </div>
  </div>

  <!-- Profile 路由 -->
  <div class="card">
    <div class="card-header">
      <h2>🔀 Profile 路由</h2>
      <button class="btn btn-green" style="margin-left:auto;font-size:12px;padding:4px 10px"
              onclick="openProfileEditor(null)">+ 添加 Profile</button>
    </div>
    <div class="card-body">
      <table><thead><tr><th>名称</th><th>触发前缀</th><th>命令</th><th>工作目录</th><th></th></tr></thead>
      <tbody id="profiles-tbody"><tr><td colspan="5" class="empty">加载中…</td></tr></tbody></table>
    </div>
  </div>

  <!-- Profile 编辑弹窗 -->
  <div id="profile-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:100;
       display:flex;align-items:center;justify-content:center;display:none">
    <div style="background:#fff;border-radius:12px;padding:24px;width:500px;max-width:95vw;
                box-shadow:0 8px 32px rgba(0,0,0,.18);max-height:90vh;overflow-y:auto">
      <h3 style="margin-bottom:16px;font-size:16px" id="modal-title">添加 Profile</h3>
      <div style="display:grid;gap:10px">
        <label style="font-size:13px;font-weight:500">Profile 名称（唯一 ID）
          <input id="pf-name" placeholder="my-claude-project" class="input-field" style="margin-top:4px"/>
        </label>
        <label style="font-size:13px;font-weight:500">触发前缀（邮件主题 [tag]）
          <input id="pf-trigger" placeholder="claude" class="input-field" style="margin-top:4px"/>
        </label>
        <label style="font-size:13px;font-weight:500">命令（command）
          <input id="pf-command" placeholder="claude" class="input-field" style="margin-top:4px"/>
        </label>
        <label style="font-size:13px;font-weight:500">参数（args，每行一个）
          <textarea id="pf-args" rows="3" placeholder="--dangerously-skip-permissions" class="input-field"
                    style="margin-top:4px;resize:vertical;font-family:monospace"></textarea>
        </label>
        <label style="font-size:13px;font-weight:500">工作目录（workdir，可选）
          <input id="pf-workdir" placeholder="/Users/me/projects/my-project" class="input-field" style="margin-top:4px"/>
        </label>
        <label style="font-size:13px;font-weight:500">描述（可选）
          <input id="pf-desc" placeholder="My Claude profile" class="input-field" style="margin-top:4px"/>
        </label>
        <label style="font-size:13px;font-weight:500">超时 ms（timeout_ms，可选，默认 300000）
          <input id="pf-timeout" placeholder="300000" type="number" class="input-field" style="margin-top:4px"/>
        </label>
        <label style="font-size:13px;font-weight:500">System Prompt（可选）
          <textarea id="pf-prompt" rows="2" class="input-field"
                    style="margin-top:4px;resize:vertical;font-size:12px"
                    placeholder="You are a helpful assistant for Project X."></textarea>
        </label>
      </div>
      <div id="modal-msg" style="font-size:12px;color:var(--red);margin-top:8px;min-height:16px"></div>
      <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
        <button class="btn btn-gray" onclick="closeProfileModal()">取消</button>
        <button id="modal-delete-btn" class="btn btn-red" style="display:none" onclick="deleteProfile()">删除</button>
        <button class="btn btn-green" onclick="saveProfile()">保存</button>
      </div>
    </div>
  </div>

  <!-- 访问控制 -->
  <div class="card">
    <div class="card-header"><h2>🛡️ 访问控制</h2></div>
    <div class="card-body" id="acl-body">加载中…</div>
    <div style="padding:0 18px 14px;border-top:1px solid var(--border);margin-top:4px">
      <div class="section-label" style="padding-top:12px">快速编辑动态名单</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
        <input id="acl-input" placeholder="user@example.com 或 @domain.com"
               style="flex:1;min-width:200px;padding:6px 10px;border:1px solid var(--border);
                      border-radius:6px;font-size:13px;outline:none"/>
        <button onclick="aclAction('allow')" class="btn btn-green">放行</button>
        <button onclick="aclAction('deny')"  class="btn btn-red">封禁</button>
        <button onclick="aclAction('reset')" class="btn btn-gray">重置</button>
      </div>
      <div id="acl-msg" style="font-size:12px;color:var(--muted);margin-top:6px;min-height:18px"></div>
    </div>
  </div>

  <!-- 批处理队列 -->
  <div class="card card-full">
    <div class="card-header">
      <h2>🕐 批处理队列</h2>
      <span class="count" id="batch-count"></span>
    </div>
    <div class="card-body">
      <table><thead><tr><th>发件人</th><th>主题</th><th>进入时间</th><th>状态</th></tr></thead>
      <tbody id="batch-tbody"><tr><td colspan="4" class="empty">无待处理邮件</td></tr></tbody></table>
    </div>
  </div>

  <!-- 处理历史 -->
  <div class="card card-full">
    <div class="card-header">
      <h2>📋 处理历史</h2>
      <span class="count" id="history-count"></span>
    </div>
    <div class="card-body">
      <table><thead><tr><th>发件人</th><th>主题</th><th>加入时间</th><th>状态</th><th></th></tr></thead>
      <tbody id="history-tbody"><tr><td colspan="5" class="empty">暂无记录</td></tr></tbody></table>
    </div>
  </div>

  <!-- 拦截记录 -->
  <div class="card card-full">
    <div class="card-header">
      <h2>⛔ 拦截记录</h2>
      <span class="count" id="denied-count"></span>
    </div>
    <div class="card-body">
      <table><thead><tr><th>发件人</th><th>主题</th><th>时间</th><th>原因</th><th>是否已上报</th></tr></thead>
      <tbody id="denied-tbody"><tr><td colspan="5" class="empty">暂无拦截记录</td></tr></tbody></table>
    </div>
  </div>
</main>

<script>
// HTML-escape user-supplied strings to prevent XSS
const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const fmt = (iso) => iso ? new Date(iso).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'}) : '-';
const statusTag = (s) => {
  const m = { replied:'<span class="tag tag-green">已回复</span>',
              queued: '<span class="tag tag-yellow">等待中</span>',
              skipped:'<span class="tag tag-gray">已跳过</span>',
              failed: '<span class="tag tag-red">失败</span>' };
  return m[s] || \`<span class="tag tag-gray">\${esc(s)}</span>\`;
};

function renderChips(arr) {
  if (!arr || !arr.length) return '<span style="color:var(--muted);font-size:12px">（无）</span>';
  return arr.map(a => \`<span class="chip">\${esc(a)}</span>\`).join('');
}

function render(state) {
  // 概览
  document.getElementById('s-profiles').textContent = state.profiles.length;
  document.getElementById('s-pending').textContent  = state.pending.queued;
  document.getElementById('s-batch').textContent    = state.batch.queued;
  document.getElementById('s-denied').textContent   = state.denied.unreported;
  document.getElementById('last-poll').textContent  = fmt(state.lastPollAt);
  document.getElementById('last-updated').textContent = '更新于 ' + fmt(state.timestamp);

  // Profiles
  const pb = document.getElementById('profiles-tbody');
  if (!state.profiles.length) {
    pb.innerHTML = '<tr><td colspan="5" class="empty">未找到 Profile 配置</td></tr>';
  } else {
    pb.innerHTML = state.profiles.map(p =>
      \`<tr><td>\${esc(p.name)}\${p.isDefault ? ' <span class="tag tag-blue">默认</span>' : ''}</td>
           <td><code>[\${esc(p.trigger)}]</code></td>
           <td style="color:var(--muted)">\${esc(p.command)}</td>
           <td style="color:var(--muted);font-size:12px;max-width:180px;overflow:hidden;text-overflow:ellipsis" title="\${esc(p.workdir||'')}">\${p.workdir ? esc(p.workdir) : '<span style="opacity:.4">—</span>'}</td>
           <td><button class="btn btn-gray btn-icon" onclick='openProfileEditor(\${esc(JSON.stringify(p))})'>编辑</button></td></tr>\`
    ).join('');
  }
  // Cache full profile list for the editor
  window._profilesState = state.profiles;

  // ACL
  const acl = state.acl;
  const ab = document.getElementById('acl-body');
  ab.innerHTML = \`
    <div class="section-label">管理员</div>
    \${renderChips(acl.static.adminSenders)}
    <div class="section-label">即时回复名单</div>
    \${renderChips(acl.static.instantReplySenders)}
    <div class="section-label">静态白名单</div>
    \${renderChips(acl.static.allowedSenders)}
    <div class="section-label">静态黑名单</div>
    \${renderChips(acl.static.deniedSenders)}
    <div class="section-label">动态白名单（/allow 指令）</div>
    \${renderChips(acl.dynamic.allowed)}
    <div class="section-label">动态黑名单（/deny 指令）</div>
    \${renderChips(acl.dynamic.denied)}
    <div class="section-label">拒绝动作</div>
    <span class="chip">\${esc(acl.static.denyAction || 'silent')}</span>
  \`;

  // 批处理队列
  const bb = document.getElementById('batch-tbody');
  const batchEntries = (state.batch.entries || []).filter(e => e.status === 'queued');
  document.getElementById('batch-count').textContent = batchEntries.length + ' 封待处理';
  if (!batchEntries.length) {
    bb.innerHTML = '<tr><td colspan="4" class="empty">无待处理邮件</td></tr>';
  } else {
    bb.innerHTML = batchEntries.map(e =>
      \`<tr><td>\${e.from_name ? esc(e.from_name) + '<br><small style="color:var(--muted)">' + esc(e.from_email) + '</small>' : esc(e.from_email)}</td>
           <td>\${esc(e.subject || '-')}</td>
           <td style="color:var(--muted);font-size:12px">\${fmt(e.queued_at)}</td>
           <td>\${statusTag(e.status)}</td></tr>\`
    ).join('');
  }

  // 处理历史
  const hb = document.getElementById('history-tbody');
  const hist = state.pending.entries || [];
  document.getElementById('history-count').textContent = '最近 ' + hist.length + ' 条';
  if (!hist.length) {
    hb.innerHTML = '<tr><td colspan="5" class="empty">暂无记录</td></tr>';
  } else {
    hb.innerHTML = hist.map(e =>
      \`<tr><td>\${esc(e.from_name || e.from_email)}</td>
           <td>\${esc(e.subject || '-')}\${e.last_error ? '<br><small style="color:var(--red);font-size:11px">' + esc(e.last_error.slice(0,80)) + '</small>' : ''}</td>
           <td style="color:var(--muted);font-size:12px">\${fmt(e.added_at)}</td>
           <td>\${e.replied && e.retries > 0
                  ? '<span class="tag tag-green">已回复<span style="opacity:.6;font-size:10px"> ↩重试后</span></span>'
                  : statusTag(e.replied ? 'replied' : (e.retries > 0 ? 'failed' : 'queued'))}</td>
           <td>\${!e.replied ? \`<button class="btn btn-gray btn-icon" onclick="discardPending('\${esc(e.message_id)}')">丢弃</button>\` : ''}</td></tr>\`
    ).join('');
  }

  // 拦截记录
  const db = document.getElementById('denied-tbody');
  const dlist = state.denied.entries || [];
  document.getElementById('denied-count').textContent = dlist.length + ' 条，其中 ' + state.denied.unreported + ' 条未上报';
  if (!dlist.length) {
    db.innerHTML = '<tr><td colspan="5" class="empty">暂无拦截记录</td></tr>';
  } else {
    db.innerHTML = dlist.map(e =>
      \`<tr><td>\${e.from_name ? esc(e.from_name) + '<br><small style="color:var(--muted)">' + esc(e.from_email) + '</small>' : esc(e.from_email)}</td>
           <td>\${esc(e.subject || '-')}</td>
           <td style="color:var(--muted);font-size:12px">\${fmt(e.received_at)}</td>
           <td>\${esc(e.reason || '-')}</td>
           <td>\${e.reported ? '<span class="tag tag-green">已上报</span>' : '<span class="tag tag-yellow">未上报</span>'}</td></tr>\`
    ).join('');
  }
}

async function refresh() {
  try {
    const r = await fetch('/api/state');
    const state = await r.json();
    render(state);
  } catch(e) {
    document.getElementById('last-updated').textContent = '刷新失败: ' + e.message;
  }
}

async function aclAction(action) {
  const address = document.getElementById('acl-input').value.trim();
  const msg = document.getElementById('acl-msg');
  if (!address) { msg.textContent = '请输入邮箱地址或域名'; msg.style.color='var(--red)'; return; }
  msg.textContent = '处理中…'; msg.style.color = 'var(--muted)';
  try {
    const r = await fetch('/api/acl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, address }),
    });
    const d = await r.json();
    if (d.ok) {
      msg.textContent = { allow:'✅ 已放行', deny:'🚫 已封禁', reset:'↩️ 已重置' }[action] + ': ' + address;
      msg.style.color = 'var(--green)';
      document.getElementById('acl-input').value = '';
      setTimeout(refresh, 500);
    } else {
      msg.textContent = '失败: ' + d.error;
      msg.style.color = 'var(--red)';
    }
  } catch(e) { msg.textContent = '请求失败: ' + e.message; msg.style.color='var(--red)'; }
}

// ── Profile Editor ────────────────────────────────────────────────────────────
let _editingProfile = null;

function openProfileEditor(profile) {
  _editingProfile = profile;
  document.getElementById('modal-title').textContent = profile ? '编辑 Profile' : '添加 Profile';
  document.getElementById('pf-name').value    = profile?.name    || '';
  document.getElementById('pf-name').disabled = !!profile;  // name is the key, can't rename
  document.getElementById('pf-trigger').value  = profile?.trigger || '';
  document.getElementById('pf-command').value  = profile?.command || '';
  document.getElementById('pf-args').value     = (profile?.args || []).join('\\n');
  document.getElementById('pf-workdir').value  = profile?.workdir || '';
  document.getElementById('pf-desc').value     = profile?.description || '';
  document.getElementById('pf-timeout').value  = profile?.timeout_ms || '';
  document.getElementById('pf-prompt').value   = profile?.system_prompt || '';
  document.getElementById('modal-msg').textContent = '';
  document.getElementById('modal-delete-btn').style.display = profile ? '' : 'none';
  document.getElementById('profile-modal').style.display = 'flex';
}

function closeProfileModal() {
  document.getElementById('profile-modal').style.display = 'none';
}

async function saveProfile() {
  const name = document.getElementById('pf-name').value.trim();
  const trigger = document.getElementById('pf-trigger').value.trim();
  const command = document.getElementById('pf-command').value.trim();
  const argsRaw = document.getElementById('pf-args').value;
  const workdir = document.getElementById('pf-workdir').value.trim();
  const desc    = document.getElementById('pf-desc').value.trim();
  const timeout = document.getElementById('pf-timeout').value.trim();
  const prompt  = document.getElementById('pf-prompt').value.trim();
  const msg     = document.getElementById('modal-msg');

  if (!name || !command) { msg.textContent = '名称和命令不能为空'; return; }
  const args = argsRaw.split('\\n').map(l => l.trim()).filter(Boolean);

  const body = { name, trigger: trigger || name, command, args };
  if (workdir) body.workdir = workdir;
  if (desc)    body.description = desc;
  if (timeout) body.timeout_ms = parseInt(timeout, 10);
  if (prompt)  body.system_prompt = prompt;

  msg.textContent = '保存中…';
  try {
    const r = await fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.ok) { closeProfileModal(); setTimeout(refresh, 300); }
    else { msg.textContent = '失败: ' + d.error; }
  } catch(e) { msg.textContent = '请求失败: ' + e.message; }
}

async function deleteProfile() {
  if (!_editingProfile) return;
  if (!confirm(\`确认删除 Profile "\${_editingProfile.name}"？\`)) return;
  const msg = document.getElementById('modal-msg');
  msg.textContent = '删除中…';
  try {
    const r = await fetch('/api/profiles/' + encodeURIComponent(_editingProfile.name), {
      method: 'DELETE',
    });
    const d = await r.json();
    if (d.ok) { closeProfileModal(); setTimeout(refresh, 300); }
    else { msg.textContent = '失败: ' + d.error; }
  } catch(e) { msg.textContent = '请求失败: ' + e.message; }
}

async function discardPending(messageId) {
  if (!confirm('确认丢弃此邮件的重试队列？')) return;
  try {
    const r = await fetch('/api/pending', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'discard', message_id: messageId }),
    });
    const d = await r.json();
    if (d.ok) { refresh(); }
    else { alert('失败: ' + d.error); }
  } catch(e) { alert('请求失败: ' + e.message); }
}

refresh();
setInterval(refresh, 15000);   // 每 15 秒自动刷新
</script>
</body>
</html>`;
}

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

/**
 * Execute an ACL mutation on the dynamic ACL file.
 * Returns { ok: true } or { error: string }.
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
    if (action === 'allow')  acl.dynamicAllow([address]);
    else if (action === 'deny')  acl.dynamicDeny([address]);
    else if (action === 'reset') acl.dynamicReset([address]);
    else throw new Error(`Unknown action: ${action}`);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Remove a single entry from the pending store (mark as replied so retry ignores it).
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

// ── Profile write helpers ─────────────────────────────────────────────────────

/**
 * Read the current profiles yaml and return { config, raw } where `config` is
 * the parsed object and `raw` is the original string (we rebuild via js-yaml dump).
 */
function _loadProfilesYaml(profilesFile) {
  const raw = fs.readFileSync(profilesFile, 'utf8');
  const yaml = require('js-yaml');
  return { config: yaml.load(raw) || {}, yaml };
}

/**
 * Save a profile entry (add or update) to email-profiles.yaml.
 * Returns { ok: true } or { error: string }.
 */
function saveProfileToYaml(profileEntry, opts = {}) {
  const profilesFile = opts.profilesConfig || path.join(process.cwd(), 'email-profiles.yaml');
  try {
    const { config, yaml } = _loadProfilesYaml(profilesFile);
    if (!config.profiles) config.profiles = {};
    const { name, ...rest } = profileEntry;
    config.profiles[name] = rest;
    const newYaml = yaml.dump(config, { lineWidth: 120, indent: 2 });
    // Atomic write: tmp + rename to avoid partial reads on crash
    const tmp = `${profilesFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, newYaml, 'utf8');
    fs.renameSync(tmp, profilesFile);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Delete a profile entry from email-profiles.yaml.
 * Returns { ok: true } or { error: string }.
 */
function deleteProfileFromYaml(name, opts = {}) {
  const profilesFile = opts.profilesConfig || path.join(process.cwd(), 'email-profiles.yaml');
  try {
    const { config, yaml } = _loadProfilesYaml(profilesFile);
    if (!config.profiles || !config.profiles[name]) {
      return { error: `Profile "${name}" not found` };
    }
    // Prevent deleting the default profile if it's the only one remaining
    if (config.default === name) {
      const remaining = Object.keys(config.profiles).filter(k => k !== name);
      if (remaining.length === 0) {
        return { error: '无法删除唯一的默认 Profile，请先添加其他 Profile 再删除' };
      }
      // Reassign default to first remaining profile
      config.default = remaining[0];
    }
    delete config.profiles[name];
    const newYaml = yaml.dump(config, { lineWidth: 120, indent: 2 });
    // Atomic write: tmp + rename to avoid partial reads on crash
    const tmp = `${profilesFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, newYaml, 'utf8');
    fs.renameSync(tmp, profilesFile);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
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
// Determine the static frontend dist directory (built React app)
const DIST_DIR = path.resolve(__dirname, 'dashboard-dist');

// Lazily-loaded and cached account info (calls agently-cli +me once per process)
let _meCache = null;
async function getAccountInfo() {
  if (_meCache) return _meCache;
  try {
    const { AgentlyMailClient } = require('./agently-mail');
    const client = new AgentlyMailClient();
    const info = await client.me();
    _meCache = info;
    return info;
  } catch {
    return null;
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

function serveStatic(urlPath, res) {
  // Security: prevent path traversal
  const safe = urlPath.replace(/\.\./g, '').replace(/^\/+/, '');
  const file = path.join(DIST_DIR, safe || 'index.html');
  // Resolve the file, fallback to index.html for SPA routing
  let target = file;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    target = path.join(DIST_DIR, 'index.html');
  }
  // Ensure target is inside DIST_DIR (belt-and-suspenders)
  if (!target.startsWith(DIST_DIR + path.sep) && target !== path.join(DIST_DIR, 'index.html')) {
    res.writeHead(403); res.end(); return;
  }
  try {
    const ext = path.extname(target);
    const mime = MIME[ext] || 'application/octet-stream';
    const content = fs.readFileSync(target);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  } catch {
    res.writeHead(404); res.end('Not Found');
  }
}

function startDashboard(opts = {}) {
  const port = opts.port || 3030;
  const host = opts.host || '127.0.0.1';

  const server = http.createServer(async (req, res) => {
    // CORS headers for local dev
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
      // Static files (React SPA)
      serveStatic(req.url, res);
      return;
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

  server.listen(port, host, () => {
    const url = `http://${host}:${port}`;
    process.stderr.write(`[dashboard] 管理面板已启动: ${url}\n`);
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
