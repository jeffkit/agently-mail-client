'use strict';
/**
 * ProfileDispatcher — Email Bridge 核心路由层
 *
 * 职责：
 *  1. 解析邮件主题前缀 [profile-name]，映射到 Profile 配置
 *  2. 清理邮件正文（剥离 HTML、移除 quoted 引用行、截断超长内容）
 *  3. 维护每个（邮件线程 × Profile）的会话历史
 *  4. 用 AgentProc P0 协议（AGENT_* env vars）spawn Profile 子进程
 *  5. 处理会话失效自动降级（无 session ID 重试）
 *
 * 这一层在功能上等价于 iLink Hub 里的 Bridge Manager + Executor，
 * 但面向邮件通道，用配置文件替代动态注册。
 *
 * 实现说明：_spawnProfile 用 child_process.spawn + Promise 异步执行，
 * 避免之前 spawnSync 长时间阻塞事件循环（poll 定时器、retry sweep、
 * SIGINT 响应都会被冻结）。dispatch 是 async。
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');
const { loadHistory, appendHistory } = require('agentproc');

const { loadProfilesConfig } = require('./yaml-loader');
const { spawnWithTimeout } = require('./spawn');
const {
  PROFILE_TIMEOUT_MS,
  MAX_BODY_LENGTH,
  SESSION_ID_PROFILE_MAX,
  SESSION_ID_HASH_LENGTH,
} = require('./constants');

// ---------------------------------------------------------------------------
// Agent session ID sidecar — persists the CLI-internal session id per email
// thread × profile pair, separate from conversation history.
//
// agentproc's appendHistory only stores { role, content, timestamp }; to
// preserve the CLI session id (e.g. claude --resume <id>) across turns we
// use a small JSON sidecar file: ~/.agentproc/email-sessions/<sid>.json
// ---------------------------------------------------------------------------

const AGENT_SESSIONS_DIR = path.join(os.homedir(), '.agentproc', 'email-sessions');

/**
 * Load the persisted agent session id for an email session.
 * Returns '' when no sidecar exists yet.
 * @param {string} emailSessionId
 * @returns {string}
 */
function loadAgentSessionId(emailSessionId) {
  const file = path.join(AGENT_SESSIONS_DIR, `${emailSessionId}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof data.agentSessionId === 'string' ? data.agentSessionId : '';
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      process.stderr.write(`[dispatcher] loadAgentSessionId(${emailSessionId}) failed: ${err.message}\n`);
    }
    return '';
  }
}

/**
 * Persist the agent session id for an email session.
 * @param {string} emailSessionId
 * @param {string} agentSessionId
 */
function saveAgentSessionId(emailSessionId, agentSessionId) {
  if (!agentSessionId) return;
  try {
    fs.mkdirSync(AGENT_SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(AGENT_SESSIONS_DIR, `${emailSessionId}.json`),
      JSON.stringify({ agentSessionId }, null, 2),
      'utf8',
    );
  } catch (err) {
    // 持久化失败不能静默：下次回复会拿到空 session，对话历史"断片"无法察觉
    process.stderr.write(
      `[dispatcher] saveAgentSessionId(${emailSessionId}) failed: ${err.message}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Email body cleaning
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags to plain text, handling common email patterns.
 *
 * @param {string} html
 * @returns {string}
 */
function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[^>]*>[\s\S]*?<\/object>/gi, '')
    // Convert block elements to newlines before stripping
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Remove Agently Mail's automatic footer injected into every sent message.
 * Pattern: "此邮件由{email}通过Agently Mail自动发送。举报退订"
 *
 * @param {string} text
 * @returns {string}
 */
function removeAgentlyFooter(text) {
  return text.replace(/\s*此邮件由[\S]+通过Agently Mail自动发送。举报退订\s*/g, '').trim();
}

/**
 * Remove quoted content from a plain-text email reply.
 *
 * Strips:
 *  1. Lines starting with ">" (standard email quoting)
 *  2. Common "On [date/time], [name] wrote:" dividers followed by ">"-prefixed lines
 *  3. Common Chinese equivalents ("发件人:", "发送时间:" block headers in reply headers)
 *  4. Trailing signature separators ("-- " on its own line)
 *
 * Unlike the previous implementation, text that appears AFTER a quoted block
 * (inline replies, post-quote comments) is preserved.  A new non-quoted section
 * is recognised when a blank line follows a quote block and non-">" text resumes.
 *
 * @param {string} text  Plain text email body
 * @returns {string}     Cleaned body with quoted sections removed
 */
function removeQuotedContent(text) {
  const lines = text.split('\n');
  const result = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Signature separator — stop processing entirely
    if (trimmed === '--' || trimmed === '-- ') break;

    // "On [date], [name] wrote:" pattern (English)
    // Everything from this divider onwards is the original email — stop here.
    if (/^On .{10,200} wrote:$/i.test(trimmed)) break;

    // Chinese / Outlook "发件人:" / "From:" header blocks mark the start of a quoted
    // original email.  Detected when ≥2 header keywords appear within the next 5 lines.
    // Everything from this block onwards is quoted — stop here.
    if (/^(发件人|From|发送时间|Sent|收件人|To|主题|Subject)\s*[:：]/.test(trimmed)) {
      const nextFew = lines.slice(i, i + 5).map((l) => l.trim());
      const headerCount = nextFew.filter((l) =>
        /^(发件人|From|发送时间|Sent|收件人|To|主题|Subject)\s*[:：]/.test(l),
      ).length;
      if (headerCount >= 2) break;
    }

    // Lines starting with ">" — skip the whole contiguous block of quoted lines,
    // then resume collecting content (inline quote, post-quote text is preserved).
    if (trimmed.startsWith('>')) {
      while (i < lines.length && lines[i].trim().startsWith('>')) i++;
      continue;
    }

    result.push(line);
    i++;
  }

  // Remove trailing blank lines
  while (result.length && !result[result.length - 1].trim()) result.pop();
  return result.join('\n');
}

/**
 * Truncate text to maxLength characters, appending a note when cut.
 *
 * @param {string} text
 * @param {number} maxLength
 * @returns {string}
 */
function truncate(text, maxLength) {
  if (!maxLength || text.length <= maxLength) return text;
  return text.slice(0, maxLength) + `\n\n[... 内容已截断，原始长度 ${text.length} 字符]`;
}

// sanitize-html 白名单：邮件渲染允许的标签/属性。
// marked 默认不净化 HTML，必须由调用方负责（marked v0.7 起的设计契约）。
const SANITIZE_OPTIONS = {
  // 不允许 <script>、<iframe>、<object>、<embed>、<form> 等
  allowedTags: [
    'p', 'br', 'hr', 'blockquote', 'pre', 'code', 'span', 'div',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'sub', 'sup', 'small',
    'a', 'img',
  ],
  allowedAttributes: {
    '*': ['class', 'id'],
    'a': ['href', 'name', 'target', 'rel', 'title'],
    'img': ['src', 'alt', 'title', 'width', 'height'],
    // 允许 inline code language class（marked 输出 <code class="language-js">）
    'code': ['class'],
    'span': ['class'],
  },
  // 强制 rel="noopener noreferrer" 给所有 target=_blank
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  // 阻断 javascript:/data: 等危险协议（自动丢弃带这些 scheme 的 href/src）
  allowedSchemesByTag: {},
  transformTags: {
    'a': (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, rel: 'noopener noreferrer', target: '_blank' },
    }),
  },
  // 不允许任何 style 属性（避免 CSS 注入）
  allowedStyles: {},
};

/**
 * Convert Markdown text to sanitized HTML using marked + sanitize-html.
 * Adds basic email styling for better readability.
 *
 * marked 自 v0.7 起不再净化 HTML（设计契约），必须由调用方净化；
 * sanitize-html 用白名单拦截 <script>/<iframe>/on*=/javascript: 等。
 *
 * @param {string} markdown
 * @returns {string} HTML string with basic styling
 */
function convertMarkdownToHtml(markdown) {
  const rawHtml = marked.parse(markdown, {
    breaks: true,  // 支持换行符转换为 <br>
    gfm: true      // 启用 GitHub Flavored Markdown
  });
  const htmlBody = sanitizeHtml(rawHtml, SANITIZE_OPTIONS);

  // 添加基础邮件样式
  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    line-height: 1.6;
    color: #24292e;
    max-width: 800px;
    margin: 0 auto;
    padding: 20px;
  }
  h1, h2, h3, h4, h5, h6 {
    margin-top: 24px;
    margin-bottom: 16px;
    font-weight: 600;
    line-height: 1.25;
  }
  h1 { font-size: 2em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
  h3 { font-size: 1.25em; }
  code {
    padding: 0.2em 0.4em;
    margin: 0;
    font-size: 85%;
    background-color: rgba(27,31,35,0.05);
    border-radius: 3px;
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  }
  pre {
    padding: 16px;
    overflow: auto;
    font-size: 85%;
    line-height: 1.45;
    background-color: #f6f8fa;
    border-radius: 3px;
  }
  pre code {
    background-color: transparent;
    padding: 0;
  }
  blockquote {
    padding: 0 1em;
    color: #6a737d;
    border-left: 0.25em solid #dfe2e5;
    margin: 0 0 16px 0;
  }
  ul, ol {
    padding-left: 2em;
    margin: 0 0 16px 0;
  }
  li {
    margin-top: 0.25em;
  }
  p {
    margin: 0 0 16px 0;
  }
  a {
    color: #0366d6;
    text-decoration: none;
  }
  a:hover {
    text-decoration: underline;
  }
  table {
    border-spacing: 0;
    border-collapse: collapse;
    margin: 0 0 16px 0;
  }
  table th, table td {
    padding: 6px 13px;
    border: 1px solid #dfe2e5;
  }
  table th {
    font-weight: 600;
    background-color: #f6f8fa;
  }
  table tr {
    background-color: #fff;
    border-top: 1px solid #c6cbd1;
  }
  table tr:nth-child(2n) {
    background-color: #f6f8fa;
  }
  hr {
    height: 0.25em;
    padding: 0;
    margin: 24px 0;
    background-color: #e1e4e8;
    border: 0;
  }
  strong {
    font-weight: 600;
  }
</style>
</head>
<body>
${htmlBody}
</body>
</html>
`.trim();
}

/**
 * Clean and normalise an email body for passing to a Profile.
 *
 * @param {object} fullMsg   Full message from AgentlyMailClient.read()
 * @param {object} [opts]
 * @param {boolean} [opts.stripQuotes=true]   Remove quoted reply content
 * @param {number}  [opts.maxLength=8000]     Truncate at this many chars (0 = no limit)
 * @returns {string}
 */
function cleanBody(fullMsg, opts = {}) {
  const { stripQuotes = true, maxLength = MAX_BODY_LENGTH } = opts;

  let text = fullMsg.body_format === 'HTML'
    ? stripHtml(fullMsg.body || '')
    : (fullMsg.body || '');

  if (stripQuotes) {
    text = removeQuotedContent(text);
  }

  // Remove Agently Mail's auto-injected footer before sending to Profile
  text = removeAgentlyFooter(text);

  return truncate(text.trim(), maxLength);
}

// ---------------------------------------------------------------------------
// ProfileDispatcher
// ---------------------------------------------------------------------------

class ProfileDispatcher {
  /**
   * @param {string} configPath  Path to email-profiles.yaml
   * @param {object} [opts]
   * @param {boolean} [opts.stripQuotes=true]    Remove quoted text from replies
   * @param {string}  [opts.configDir]           Base dir for resolving relative workdir paths
   * @param {number}  [opts.maxBodyLength=8000] Truncate body at N chars (0=off)
   */
  constructor(configPath, opts = {}) {
    this.configPath = configPath;
    this.config = loadProfilesConfig(configPath);
    this.configDir = path.dirname(path.resolve(configPath));
    this.stripQuotes = opts.stripQuotes !== false;
    this.maxBodyLength = opts.maxBodyLength ?? MAX_BODY_LENGTH;

    // Inject configDir into each profile so _spawnProfile can resolve relative paths
    for (const cfg of Object.values(this.config.profiles)) {
      cfg._configDir = this.configDir;
    }
  }

  /**
   * List configured profile names.
   * @returns {string[]}
   */
  profileNames() {
    return Object.keys(this.config.profiles);
  }

  /**
   * Reload profiles config from disk (hot-reload on file change).
   * In-flight dispatches are unaffected; new dispatches pick up the fresh config.
   */
  reload() {
    try {
      this.config    = loadProfilesConfig(this.configPath);
      this.configDir = path.dirname(path.resolve(this.configPath));
      process.stderr.write(
        `[email-bridge] Profiles config hot-reloaded: ${this.profileNames().length} profile(s): ${this.profileNames().join(', ')}\n`,
      );
    } catch (err) {
      process.stderr.write(`[email-bridge] Failed to reload profiles config: ${err.message}\n`);
    }
  }

  /**
   * Resolve which Profile handles a given email subject.
   *
   * Rules (checked in order):
   *  1. Subject starts with "[tag]" → match by trigger or profile name
   *  2. Fall back to the configured default profile
   *
   * @param {string} subject
   * @returns {{ profileName: string, profileConfig: object, cleanSubject: string }}
   */
  resolveProfile(subject) {
    const m = (subject || '').match(/^\[([^\]]+)\]\s*/);
    if (m) {
      const tag = m[1].toLowerCase();
      const clean = subject.slice(m[0].length);
      for (const [name, cfg] of Object.entries(this.config.profiles)) {
        if ((cfg.trigger && cfg.trigger.toLowerCase() === tag) || name === tag) {
          return { profileName: name, profileConfig: cfg, cleanSubject: clean };
        }
      }
    }

    const defaultName = this.config.default;
    const defaultCfg = this.config.profiles[defaultName];
    if (!defaultCfg) throw new Error(`Default profile "${defaultName}" not found in config`);
    return { profileName: defaultName, profileConfig: defaultCfg, cleanSubject: subject };
  }

  /**
   * Dispatch a full email message to the appropriate Profile.
   *
   * @param {object}  fullMsg  Full message from AgentlyMailClient.read()
   * @param {boolean} dryRun   Skip Profile spawn, return placeholder
   * @returns {Promise<{ response: string, profileName: string }>}
   */
  async dispatch(fullMsg, dryRun = false) {
    const { subject, from } = fullMsg;
    const senderEmail = from?.email || 'unknown';
    const senderName = from?.name || senderEmail;
    const messageId = fullMsg.message_id || '(unknown)';

    // 1. Resolve profile
    const { profileName, profileConfig, cleanSubject } = this.resolveProfile(subject || '');

    // 2. Build message string (AGENT_MESSAGE), cleaning up quoted content
    const body = cleanBody(fullMsg, {
      stripQuotes: this.stripQuotes,
      maxLength: this.maxBodyLength,
    });

    // System prompt: per-profile > global config > built-in default
    const DEFAULT_SYSTEM_PROMPT =
      '你是一个智能邮件 AI 助手。请直接回复以下邮件，像正常邮件往来一样给出回复正文。不要描述或分析邮件本身，直接切入内容回复。';
    const systemPrompt =
      profileConfig.system_prompt ||
      this.config.system_prompt ||
      DEFAULT_SYSTEM_PROMPT;

    const message = [
      systemPrompt,
      '',
      `发件人: ${senderName} <${senderEmail}>`,
      `主题: ${cleanSubject}`,
      '',
      body,
    ].join('\n');

    // 3. Load thread × profile session history
    const sid = this._sessionId(fullMsg, profileName);
    const history = loadHistory(sid);
    void history; // loadHistory warms the sidecar; appendHistory will read it again
    // Agent session id (e.g. claude --resume) stored in a separate sidecar
    const prevSessionId = loadAgentSessionId(sid);

    // 4. Spawn Profile with P0 protocol (async)
    let response, newSessionId;
    try {
      ({ response, newSessionId } = await this._spawnProfile(
        profileConfig, message, prevSessionId,
        `email-${senderEmail}`, senderEmail, dryRun, profileName, messageId,
      ));
    } catch (err) {
      // AGENT_ERROR 抛出的 ProfileError 不应触发 session 重试（profile 已正常退出，
      // 只是报告了应用层错误）。只有 spawn 失败 / 非零退出 / 信号 kill / 超时
      // 才走 session 降级重试。
      if (prevSessionId && !err.isProfileError) {
        process.stderr.write(
          `[dispatcher] msg=${messageId} profile=${profileName} session=${prevSessionId} ` +
          `may be expired, retrying fresh: ${err.message}\n`,
        );
        ({ response, newSessionId } = await this._spawnProfile(
          profileConfig, message, '',
          `email-${senderEmail}`, senderEmail, dryRun, profileName, messageId,
        ));
      } else {
        throw err;
      }
    }

    // 5. Persist history and agent session id
    appendHistory(sid, [
      { role: 'user', content: message },
      { role: 'assistant', content: response },
    ]);
    saveAgentSessionId(sid, newSessionId);

    return { response, profileName };
  }

  /**
   * Compute a stable session ID for a (thread × profile) pair.
   *
   * Thread grouping strategy:
   *  - If the message has a References header, use the FIRST entry (the thread root)
   *  - If only In-Reply-To is set, use that (direct parent = thread root for 1-level threads)
   *  - Otherwise use the message's own RFC Message-ID (start of a new thread)
   *
   * All replies in the same email chain therefore share one session, so the
   * AI Profile maintains conversation context across the full thread.
   *
   * 安全：threadRoot 来自邮件头（攻击者可控）。早期实现直接 slice(0,80)
   * 的子串，攻击者可构造相同 Message-ID 精确碰撞，复用他人会话历史。
   * 现在取 SHA1 前 N 位，碰撞不可控；profileName 也做 sanitize 防止路径注入。
   *
   * @private
   */
  _sessionId(fullMsg, profileName) {
    // references[0] is the oldest (root) message in the thread per RFC 2822
    const threadRoot =
      (Array.isArray(fullMsg.references) && fullMsg.references.length > 0
        ? fullMsg.references[0]
        : null) ||
      fullMsg.in_reply_to ||
      fullMsg.rfc_message_id ||
      fullMsg.message_id ||
      'unknown';

    // profileName 来自 yaml 键（运营者可控，但仍 sanitize 兜底）
    const safeProfile = String(profileName).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, SESSION_ID_PROFILE_MAX);
    // SHA1(threadRoot) 前 N 位 —— 不可碰撞且固定长度，不泄露原 Message-ID
    const hash = crypto
      .createHash('sha1')
      .update(String(threadRoot))
      .digest('hex')
      .slice(0, SESSION_ID_HASH_LENGTH);
    const sid = `email_${safeProfile}_${hash}`;
    // 终极兜底：sid 必须形如 ^email_[A-Za-z0-9_-]+$
    if (!/^email_[A-Za-z0-9_-]+$/.test(sid)) {
      return `email_${safeProfile}_invalid`;
    }
    return sid;
  }

  /**
   * Dispatch a raw message directly to a named profile, bypassing email-specific
   * context (sender, subject, thread). Used by ScheduleRunner for cron tasks.
   *
   * @param {string} profileName
   * @param {string} message        AGENT_MESSAGE content
   * @param {string} [sessionId=''] Stable session id for conversation continuity
   * @param {boolean} [dryRun=false]
   * @returns {Promise<{ response: string, profileName: string }>}
   */
  async dispatchRaw(profileName, message, sessionId = '', dryRun = false) {
    const cfg = this.config.profiles[profileName];
    if (!cfg) throw new Error(`Profile "${profileName}" not found`);

    const { response, newSessionId } = await this._spawnProfile(
      cfg, message, sessionId, `schedule-${profileName}`, '', dryRun, profileName, 'scheduled',
    );

    appendHistory(sessionId || `schedule_${profileName}`, [
      { role: 'user', content: message },
      { role: 'assistant', content: response },
    ]);
    saveAgentSessionId(sessionId || `schedule_${profileName}`, newSessionId);

    return { response, profileName };
  }

  /** @private */
  async _spawnProfile(cfg, message, sessionId, sessionName, fromUser, dryRun, profileName, messageId) {
    if (dryRun) {
      return {
        response: `[DRY_RUN] Profile would handle: "${message.slice(0, 80)}..."`,
        newSessionId: sessionId || 'dry-run-' + Date.now(),
      };
    }

    const configDir = cfg._configDir || __dirname;
    const args = (cfg.args || []).map((a) =>
      a.startsWith('.') ? path.resolve(configDir, a) : a,
    );

    const tag = `[dispatcher] msg=${messageId} profile=${profileName || cfg.command}`;

    // Per-profile timeout_ms overrides global PROFILE_TIMEOUT_MS
    const timeoutMs = (cfg.timeout_ms && Number.isFinite(cfg.timeout_ms) && cfg.timeout_ms > 0)
      ? cfg.timeout_ms
      : PROFILE_TIMEOUT_MS;

    // Per-profile workdir: resolve relative paths against the profiles yaml directory
    let cwd;
    if (cfg.workdir) {
      cwd = path.isAbsolute(cfg.workdir)
        ? cfg.workdir
        : path.resolve(this.configDir || process.cwd(), cfg.workdir);
    }

    let result;
    try {
      result = await spawnWithTimeout(cfg.command, args, {
        timeoutMs,
        cwd,
        env: {
          ...process.env,
          AGENT_MESSAGE: message,
          AGENT_SESSION_ID: sessionId || '',
          AGENT_SESSION_NAME: sessionName || 'email',
          AGENT_FROM_USER: fromUser || '',
          AGENT_STREAMING: '1',
        },
      });
    } catch (err) {
      throw new Error(`Failed to spawn profile "${cfg.command}": ${err.message}`);
    }

    // 子进程被信号 kill（如 SIGKILL/超时/OOM）：返回明确错误，绝不返回残缺响应
    if (result.signal) {
      throw new Error(
        `${tag} killed by signal ${result.signal}` +
        (result.stderr.trim() ? `: ${result.stderr.trim().slice(-512)}` : ''),
      );
    }
    if (result.code !== 0) {
      const stderr = (result.stderr || '').trim();
      throw new Error(
        `${tag} exited with code ${result.code}` + (stderr ? `: ${stderr.slice(-512)}` : ''),
      );
    }

    // Parse AgentProc P0 stdout: AGENT_SESSION / AGENT_PARTIAL / AGENT_ERROR lines
    let newSessionId = sessionId || '';
    const parts = [];
    for (const line of (result.stdout || '').split('\n')) {
      if (line.startsWith('AGENT_SESSION:')) {
        newSessionId = line.slice('AGENT_SESSION:'.length).trim();
      } else if (line.startsWith('AGENT_PARTIAL:')) {
        try { parts.push(JSON.parse(line.slice('AGENT_PARTIAL:'.length))); }
        catch { parts.push(line.slice('AGENT_PARTIAL:'.length)); }
      } else if (line.startsWith('AGENT_ERROR:')) {
        // profile 已正常退出（code=0），只是报告了应用层错误。
        // 改为返回错误响应而非 throw：避免穿透到 dispatch 的 catch
        // 触发"清空 session 重试"，白白烧掉一次成功的 LLM 调用。
        let errMsg;
        try { errMsg = JSON.parse(line.slice('AGENT_ERROR:'.length)); }
        catch { errMsg = line.slice('AGENT_ERROR:'.length); }
        const err = new Error(`${tag} AGENT_ERROR: ${errMsg}`);
        err.isProfileError = true;
        throw err;
      } else {
        parts.push(line);
      }
    }

    return { response: parts.join('\n').trim(), newSessionId };
  }
}

// ProfileError 标记：用于 dispatch 判断是否应走 session 重试降级
function isProfileError(err) {
  return Boolean(err && err.isProfileError);
}

module.exports = {
  ProfileDispatcher,
  loadProfilesConfig,
  cleanBody,
  stripHtml,
  removeQuotedContent,
  removeAgentlyFooter,
  truncate,
  convertMarkdownToHtml,
  spawnWithTimeout,
  isProfileError,
};
