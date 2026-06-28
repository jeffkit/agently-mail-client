'use strict';
/**
 * agently-mail-client — 主入口
 *
 * 暴露三个核心模块：
 *  - AgentlyMailClient  邮件收发 SDK（agently-cli subprocess 封装）
 *  - ProfileDispatcher  邮件到 Profile 的路由 + 会话管理层
 *  - createEmailBridge  一键启动函数（顶层 API）
 *
 * @example
 * const { createEmailBridge } = require('agently-mail-client');
 *
 * createEmailBridge({
 *   profilesConfig: './email-profiles.yaml',
 *   pollIntervalMs: 5 * 60_000,
 * });
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { AgentlyMailClient, AgentlyMailError } = require('./agently-mail');
const { ProfileDispatcher, convertMarkdownToHtml } = require('./dispatcher');
const { PendingStore } = require('./pending-store');
const { AclConfig } = require('./acl-config');
const { SenderAcl } = require('./sender-acl');
const { DeniedLog } = require('./denied-log');
const { AdminHandler } = require('./admin-handler');
const { BatchStore } = require('./batch-store');
const { BatchHandler } = require('./batch-handler');
const { matchesAny } = require('./sender-acl');
const {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_ADAPTIVE_MIN_INTERVAL_MS,
} = require('./constants');
const { ScheduleRunner } = require('./schedule-runner');
const builtinHandlers = require('./builtin-handlers');

// Re-export createProfile from agentproc (AgentProc P0 protocol)
const { createProfile: _createProfile } = require('agentproc');
const createProfile = _createProfile;

// ---------------------------------------------------------------------------
// Self-email filter helpers
// ---------------------------------------------------------------------------

/**
 * Collect all email addresses belonging to the authenticated account.
 * Includes all aliases to guard against edge cases.
 *
 * @param {AgentlyMailClient} mail
 * @returns {Promise<Set<string>>}  lowercase email addresses
 */
async function getOwnAddresses(mail) {
  try {
    const me = await mail.me();
    const addresses = new Set();
    for (const alias of (me?.aliases || [])) {
      if (alias.email) addresses.add(alias.email.toLowerCase());
    }
    return addresses;
  } catch {
    return new Set();
  }
}

/**
 * Return true if the message was sent by ourselves.
 * Catches two common self-loop patterns:
 *  1. from.email matches our own address (reply-to-self or Echo-generated)
 *  2. Subject starts with "Re:" AND sender is us (our own reply came back as unread)
 *
 * @param {object}      msgSummary   From +list
 * @param {Set<string>} ownAddresses
 * @returns {boolean}
 */
function isSelfSent(msgSummary, ownAddresses) {
  const senderEmail = (msgSummary.from?.email || '').toLowerCase();
  return ownAddresses.has(senderEmail);
}

// ---------------------------------------------------------------------------
// createEmailBridge
// ---------------------------------------------------------------------------

/**
 * Start the email bridge daemon.
 *
 * @param {object}  [options]
 * @param {string}  [options.profilesConfig]   Path to email-profiles.yaml
 * @param {string}  [options.aclConfig]        Path to email-acl.yaml (optional)
 * @param {number}  [options.pollIntervalMs]   Poll interval in ms (default 300_000)
 * @param {boolean} [options.dryRun]           Skip actual replies (default false)
 * @param {number}  [options.limit]            Max messages per poll cycle (default 20)
 * @param {boolean} [options.filterSelfSent]   Skip emails sent by our own address (default true)
 * @param {string}  [options.pendingStoreFile] Custom path for pending state JSON file
 * @returns {{ stop: () => void }}
 */
function createEmailBridge(options = {}) {
  const {
    profilesConfig = path.join(process.cwd(), 'email-profiles.yaml'),
    aclConfig: aclConfigFile = (() => {
      const candidate = path.join(process.cwd(), 'email-acl.yaml');
      return fs.existsSync(candidate) ? candidate : null;
    })(),
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    adaptivePolling = process.env.ADAPTIVE_POLLING !== '0', // default: on
    adaptiveMinIntervalMs = DEFAULT_ADAPTIVE_MIN_INTERVAL_MS,
    dryRun = process.env.DRY_RUN === '1',
    limit = 20,
    filterSelfSent = true,
    pendingStoreFile,
    batchStoreFile,
    schedulesConfig: schedulesConfigFile = (() => {
      const candidate = path.join(process.cwd(), 'email-schedules.yaml');
      return fs.existsSync(candidate) ? candidate : path.join(process.cwd(), 'email-schedules.yaml');
    })(),
  } = options;

  // Cursor file lives alongside the pending store for persistence across restarts
  const storeDir = pendingStoreFile
    ? path.dirname(pendingStoreFile)
    : path.join(os.homedir(), '.agently-mail-client');
  const cursorFile = path.join(storeDir, 'poll-cursor.json');

  function loadCursor() {
    try {
      if (fs.existsSync(cursorFile)) {
        const { afterTimestamp } = JSON.parse(fs.readFileSync(cursorFile, 'utf8'));
        if (afterTimestamp) return afterTimestamp;
      }
    } catch (err) {
      // 游标损坏不能静默：进程会从 now 重启，丢掉之前未处理的批次
      process.stderr.write(`[email-bridge] Failed to load poll cursor: ${err.message}\n`);
    }
    return null;
  }

  function saveCursor(ts) {
    try {
      fs.mkdirSync(storeDir, { recursive: true });
      fs.writeFileSync(cursorFile, JSON.stringify({ afterTimestamp: ts }, null, 2), 'utf8');
    } catch (err) {
      // 持久化失败不能静默：进程重启后会重复处理上一批
      process.stderr.write(`[email-bridge] Failed to save poll cursor: ${err.message}\n`);
    }
  }

  const mail       = new AgentlyMailClient();
  const dispatcher = new ProfileDispatcher(profilesConfig);
  const pending    = new PendingStore(pendingStoreFile);
  const aclCfg     = new AclConfig({
    aclConfigFile,
    dynamicFile: pendingStoreFile
      ? path.join(path.dirname(pendingStoreFile), 'acl-dynamic.json')
      : undefined,
  });
  const acl        = new SenderAcl(aclCfg);
  const deniedLog  = new DeniedLog(
    pendingStoreFile
      ? path.join(path.dirname(pendingStoreFile), 'denied-log.json')
      : undefined,
  );
  const admin      = new AdminHandler(aclCfg, deniedLog, mail, { dryRun });

  // 批处理模式：从 aclCfg 静态配置读取 batch_mode 段
  const batchCfg         = aclCfg._static?.batch_mode || {};
  const batchEnabled     = batchCfg.enabled === true;
  const batchIntervalMs  = (batchCfg.collect_interval_hours || 2) * 60 * 60 * 1000;
  // 即时回复名单：顶层字段，与白名单语义独立
  const batchTrustedSenders = aclCfg.instantReplySenders;

  const batchStore = new BatchStore(
    batchStoreFile ||
    path.join(
      pendingStoreFile
        ? path.dirname(pendingStoreFile)
        : path.join(os.homedir(), '.agently-mail-client'),
      'batch-queue.json',
    ),
  );

  // dispatchAndReply 在后面定义，BatchHandler 通过闭包引用
  let _dispatchAndReplyRef = null;
  const batchHandler = batchEnabled
    ? new BatchHandler({
        batchStore,
        aclConfig:        aclCfg,
        mailClient:       mail,
        dispatcher,
        dispatchAndReply: (...args) => _dispatchAndReplyRef?.(...args),
        batchConfig:      batchCfg,
        dryRun,
      })
    : null;

  const profileNames = dispatcher.profileNames();
  process.stderr.write(
    `[email-bridge] Loaded ${profileNames.length} profile(s): ${profileNames.join(', ')}\n`,
  );

  // Verify auth and collect own addresses for self-filter (async, runs at startup)
  let ownAddresses = new Set();
  (async () => {
    try {
      const me = await mail.me();
      const email = me?.aliases?.[0]?.email || 'unknown';
      ownAddresses = await getOwnAddresses(mail);
      const adminList = aclCfg.adminSenders;
      const pollDesc = adaptivePolling
        ? `adaptive (${adaptiveMinIntervalMs / 1000}s–${pollIntervalMs / 1000}s)`
        : `${pollIntervalMs / 1000}s fixed`;
      process.stderr.write(
        `[email-bridge] Monitoring ${email} every ${pollDesc}\n` +
        `[email-bridge] Subject prefix routing: [profile-name], default=${dispatcher.config.default}\n` +
        (filterSelfSent ? `[email-bridge] Self-sent filter: ON (${[...ownAddresses].join(', ')})\n` : '') +
        (acl.isOpenAccess() ? '' : `[email-bridge] Sender ACL: ON (deny_action=${acl.denyAction})\n`) +
        (adminList.length > 0 ? `[email-bridge] Admin senders: ${adminList.join(', ')}\n` : '') +
        (aclConfigFile ? `[email-bridge] ACL config: ${aclConfigFile}\n` : '[email-bridge] ACL config: (none — open access)\n'),
      );
    } catch (err) {
      // Rate-limit (429) is transient — warn and continue without self-filter.
      // Any other error (auth invalid, binary missing) is fatal.
      const isRateLimit = /429|rate.?limit/i.test(err.message);
      if (isRateLimit) {
        process.stderr.write(
          `[email-bridge] ⚠ +me rate-limited at startup; self-sent filter disabled until next poll.\n` +
          `[email-bridge]   Profile routing: default=${dispatcher.config.default}\n`,
        );
      } else {
        process.stderr.write(
          `[email-bridge] Auth check failed: ${err.message}\n` +
          `  Run: agently-cli auth login\n`,
        );
        process.exit(3);
      }
    }
  })();

  /**
   * Lightweight trace id generator: 6 hex chars. Used to correlate log lines
   * across the poll → dispatch → reply chain for a single message.
   */
  function traceId() {
    return Math.random().toString(16).slice(2, 8);
  }

  /**
   * Tagged logger — writes a single line with [email-bridge] prefix + trace id.
   * @param {string} tid
   * @param {string} msg
   */
  function log(tid, msg) {
    process.stderr.write(`[email-bridge]${tid ? ` [${tid}]` : ''} ${msg}\n`);
  }

  /**
   * Handle a sender that failed ACL checks: log it and optionally notify.
   */
  async function handleDenied(client, msg, reason) {
    const { message_id, subject, from } = msg;
    process.stderr.write(
      `[email-bridge] ACL denied: "${subject}" from ${from?.email} — ${reason}\n`,
    );

    deniedLog.record(msg, reason);

    // Mark as done in pending store to prevent retry sweep re-processing
    pending.add(msg);
    pending.markReplied(message_id);

    if (acl.denyAction === 'notify' && !dryRun) {
      const body = acl.denyMessage ||
        '感谢您的来信。您的邮件无法被自动处理，请联系管理员。\n\nThank you for your message. Your email could not be processed automatically. Please contact the administrator.';
      try {
        await client.reply(message_id, body, { bodyFormat: 'plain' });
        process.stderr.write(`[email-bridge] ACL deny notification sent: ${message_id}\n`);
      } catch (err) {
        process.stderr.write(`[email-bridge] ACL notify reply failed: ${err.message}\n`);
      }
    }
  }

  // In-memory guard: tracks message IDs currently being dispatched.
  // Prevents retry sweep from launching a second dispatch while the poll
  // handler's dispatchAndReply is still running (e.g. waiting for Claude).
  const processingSet = new Set();

  /**
   * Core dispatch-and-reply logic, shared between new mail handler and retry handler.
   * Returns true on success, false on failure.
   */
  async function dispatchAndReply(message_id, subject, fromEmail, client, isRetry = false) {
    if (processingSet.has(message_id)) {
      log('', `Skipping duplicate dispatch for ${message_id} (already in progress)`);
      return true;
    }
    processingSet.add(message_id);
    const tid = traceId();
    try {
      const tag = isRetry ? '[RETRY]' : '';
      log(tid, `${tag} Processing: "${subject}" from ${fromEmail} (${message_id})`);

      let fullMsg;
      try {
        fullMsg = await client.read(message_id);
      } catch (err) {
        log(tid, `${tag} Failed to read ${message_id}: ${err.message}`);
        pending.markFailed(message_id, `read failed: ${err.message}`);
        return false;
      }

      // Resolve profile first so we can run per-profile ACL check
      let resolvedProfile;
      try {
        resolvedProfile = dispatcher.resolveProfile(fullMsg.subject || '');
      } catch (err) {
        log(tid, `${tag} Profile resolution failed: ${err.message}`);
        pending.markFailed(message_id, `profile resolve failed: ${err.message}`);
        return false;
      }

      // Per-profile ACL check (global ACL already passed in poll handler)
      if (acl.checkProfile(resolvedProfile.profileName, fromEmail) === 'deny') {
        log(tid, `${tag} ACL denied profile "${resolvedProfile.profileName}" for ${fromEmail}`);
        // Build a minimal msg-like object for handleDenied (retry path may not have full msg)
        const msgSummary = { message_id, subject, from: { email: fromEmail } };
        await handleDenied(client, msgSummary, `profile "${resolvedProfile.profileName}" not allowed`);
        return true; // treated as "handled", not a retriable failure
      }

      let response, profileName;
      try {
        ({ response, profileName } = await dispatcher.dispatch(fullMsg, dryRun));
      } catch (err) {
        const failedAt = new Date().toISOString();
        log(tid, `${tag} Dispatch failed for ${message_id} (profile=${resolvedProfile.profileName}) at ${failedAt}: ${err.message}`);
        pending.markFailed(message_id, `dispatch failed: ${err.message}`);
        return false;
      }

      log(tid, `${tag} Profile: ${profileName} → ${response.length} chars`);

      if (!dryRun) {
        try {
          const htmlResponse = convertMarkdownToHtml(response);
          await client.reply(message_id, htmlResponse, { bodyFormat: 'html' });
          pending.markReplied(message_id);
          log(tid, `${tag} Replied (HTML): ${message_id}`);
        } catch (err) {
          log(tid, `${tag} Reply failed for ${message_id}: ${err.message}`);
          pending.markFailed(message_id, `reply failed: ${err.message}`);
          return false;
        }
      } else {
        pending.markReplied(message_id);
        log(tid, `${tag} [DRY_RUN] Would reply: ${response.slice(0, 120)}`);
      }
      return true;
    } finally {
      processingSet.delete(message_id);
    }
  }

  // 将 dispatchAndReply 绑定给 BatchHandler 的闭包引用
  _dispatchAndReplyRef = dispatchAndReply;

  const savedCursor = loadCursor();
  if (savedCursor) {
    process.stderr.write(`[email-bridge] Resuming from cursor: ${savedCursor}\n`);
  }

  const poller = mail.poll(pollIntervalMs, async (msg, client) => {
    const { message_id, subject, from } = msg;
    const senderEmail = from?.email || '';
    const tid = traceId();

    try {
      // Skip emails we sent ourselves (prevents reply loops)
      if (filterSelfSent && isSelfSent(msg, ownAddresses)) {
        log(tid, `Skipping self-sent: "${subject}" (${message_id})`);
        return;
      }

      // Admin path: read message, check for commands, bypass normal ACL + dispatch
      if (acl.isAdmin(senderEmail)) {
        log(tid, `Admin message from ${senderEmail}: "${subject}"`);
        let fullMsg;
        try {
          fullMsg = await client.read(message_id);
        } catch (err) {
          log(tid, `Admin message read failed: ${err.message} — will retry on next sweep`);
          pending.add(msg);
          pending.markFailed(message_id, `admin read failed: ${err.message}`);
          return;
        }
        const body = fullMsg ? _plainBody(fullMsg) : '';

        // 批处理模式：admin 回复摘要邮件 → 交给 BatchHandler 解读执行
        if (batchHandler && batchHandler.isBatchReply(subject)) {
          log(tid, `Batch owner reply from ${senderEmail}: "${subject}"`);
          await batchHandler.handleOwnerReply(message_id, fullMsg, senderEmail);
          return;
        }

        if (admin.hasCommands(body)) {
          await admin.executeCommands(message_id, body, senderEmail);
          return;
        }
        // Admin with no commands → fall through to normal dispatch
      }

      // Global ACL check (non-admin senders)
      if (!acl.isAdmin(senderEmail) && acl.checkGlobal(senderEmail) === 'deny') {
        await handleDenied(client, msg, 'global ACL');
        return;
      }

      // 批处理模式分流：
      //   - admin 发件人始终走即时处理
      //   - instant_reply_senders（信任域）走即时处理
      //   - 其余进入批队列
      if (batchHandler && !acl.isAdmin(senderEmail) &&
          !matchesAny(senderEmail, batchTrustedSenders)) {
        // 读取完整消息以提取正文摘要（read() 同时在服务端标记已读，所以先 add）
        pending.add(msg);
        let fullMsg;
        try {
          fullMsg = await client.read(message_id);
        } catch (err) {
          log(tid, `Batch read failed for ${message_id}: ${err.message}`);
          pending.markFailed(message_id, `read failed: ${err.message}`);
          return;
        }
        batchHandler.enqueue(msg, fullMsg);
        // 批队列里的邮件不走 dispatchAndReply，标记 pending 为"已处理"以防 retry sweep 重触发
        pending.markReplied(message_id);
        log(tid, `[BATCH] Queued (not dispatched): "${subject}" from ${senderEmail}`);
        return;
      }

      // 即时处理路径（信任域 / admin / 非批处理模式）
      pending.add(msg);

      await dispatchAndReply(message_id, subject, senderEmail, client, false);
    } catch (err) {
      // 兜底：handler 内部错误不能让整个 poll tick 失败累积
      log(tid, `Unhandled error in poll handler for ${message_id}: ${err.message}`);
    }
  }, {
    limit,
    afterTimestamp: savedCursor || undefined,
    saveCursor,
    adaptive: adaptivePolling,
    minIntervalMs: adaptiveMinIntervalMs,
  });

  // Retry sweep: runs on every poll interval even when inbox is empty.
  // Delayed by half an interval so it doesn't fire simultaneously with the
  // main poll, spreading API calls evenly and reducing burst rate.
  let retryTimer = null;
  const runRetrySweep = async () => {
    try {
      const retryQueue = pending.getPending();
      if (retryQueue.length === 0) {
        pending.cleanup();
        return;
      }
      log('', `Retry sweep: ${retryQueue.length} pending message(s)`);
      const client = mail;
      for (const entry of retryQueue) {
        try {
          await dispatchAndReply(entry.message_id, entry.subject, entry.from_email, client, true);
        } catch (err) {
          // 单条失败不阻塞 sweep
          log('', `Retry sweep dispatch threw for ${entry.message_id}: ${err.message}`);
        }
      }
      pending.cleanup();
    } catch (err) {
      // sweep 整体失败不能让 setInterval 死掉
      log('', `Retry sweep failed (will retry next tick): ${err.message}`);
    }
  };
  // Start retry sweep after half-interval offset to avoid simultaneous poll+retry bursts
  setTimeout(() => {
    runRetrySweep();
    retryTimer = setInterval(runRetrySweep, pollIntervalMs);
  }, Math.floor(pollIntervalMs / 2));

  // Start inspection report scheduler
  admin.startReportScheduler();

  // Start batch summary scheduler (if enabled)
  if (batchHandler) {
    batchHandler.start(batchIntervalMs);
    process.stderr.write(
      `[email-bridge] Batch mode: ON (interval=${batchCfg.collect_interval_hours || 2}h, ` +
      `trusted=${batchTrustedSenders.length > 0 ? batchTrustedSenders.join(', ') : 'none'})\n`,
    );
  }

  // Start scheduled tasks
  const scheduleRunner = new ScheduleRunner({
    configPath: schedulesConfigFile,
    dispatcher,
    mailClient: mail,
    builtinHandlers,
    dryRun,
  });
  scheduleRunner.start();

  // Graceful shutdown
  const stop = () => {
    poller.stop();
    admin.stopReportScheduler();
    if (batchHandler) batchHandler.stop();
    if (retryTimer) clearInterval(retryTimer);
    scheduleRunner.stop();
  };
  process.on('SIGINT', () => {
    process.stderr.write('\n[email-bridge] Stopping...\n');
    stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => { stop(); process.exit(0); });

  return { stop };
}

/** Extract plain text from a full message (strips HTML + quoted content). */
function _plainBody(fullMsg) {
  const { cleanBody } = require('./dispatcher');
  try { return cleanBody(fullMsg, { stripQuotes: true }); } catch { return ''; }
}

module.exports = {
  AgentlyMailClient,
  AgentlyMailError,
  ProfileDispatcher,
  PendingStore,
  AclConfig,
  SenderAcl,
  DeniedLog,
  AdminHandler,
  BatchStore,
  BatchHandler,
  createEmailBridge,
  createProfile,
  convertMarkdownToHtml,
};
