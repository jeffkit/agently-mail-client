'use strict';
/**
 * agently-mail-client — 主入口（Orchestrator）
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

const { randomBytes } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AgentlyMailClient, AgentlyMailError } = require('./agently-mail');
const { ProfileDispatcher, convertMarkdownToHtml } = require('./dispatcher');
const { PendingStore } = require('./pending-store');
const { MailArchive, computeThreadRoot } = require('./mail-archive');
const { AclConfig } = require('./acl-config');
const { SenderAcl } = require('./sender-acl');
const { DeniedLog } = require('./denied-log');
const { AdminHandler } = require('./admin-handler');
const { BatchStore } = require('./batch-store');
const { BatchHandler } = require('./batch-handler');
const {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_ADAPTIVE_MIN_INTERVAL_MS,
} = require('./constants');
const { ScheduleRunner } = require('./schedule-runner');
const builtinHandlers = require('./builtin-handlers');
const { createDispatcher } = require('./dispatch-core');
const { createPollHandler } = require('./poll-handler');
const { createRetrySweep } = require('./retry-sweep');

// Re-export createProfile from agentproc (AgentProc P0 protocol)
const { createProfile: _createProfile } = require('agentproc');
const createProfile = _createProfile;

// ---------------------------------------------------------------------------
// Self-email filter helpers
// ---------------------------------------------------------------------------

/**
 * Collect all email addresses belonging to the authenticated account.
 * @param {AgentlyMailClient} mail
 * @returns {Promise<Set<string>>}
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

// ---------------------------------------------------------------------------
// createEmailBridge
// ---------------------------------------------------------------------------

/**
 * Start the email bridge daemon.
 *
 * @param {object}  [options]
 * @param {string}  [options.profilesConfig]   Path to email-profiles.yaml
 * @param {string}  [options.aclConfig]        Path to email-acl.yaml (optional)
 * @param {number}  [options.pollIntervalMs]   Poll interval in ms (default 900_000)
 * @param {boolean} [options.adaptivePolling]  Enable adaptive polling (default true)
 * @param {number}  [options.adaptiveMinIntervalMs]
 * @param {boolean} [options.dryRun]           Skip actual replies (default false)
 * @param {number}  [options.limit]            Max messages per poll cycle (default 20)
 * @param {boolean} [options.filterSelfSent]   Skip emails sent by our own address (default true)
 * @param {string}  [options.pendingStoreFile] Custom path for pending state JSON file
 * @param {string}  [options.archiveFile]      Custom path for mail archive JSONL file
 * @param {string}  [options.batchStoreFile]   Custom path for batch queue JSON file
 * @param {string}  [options.schedulesConfig]  Path to email-schedules.yaml
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
    adaptivePolling = process.env.ADAPTIVE_POLLING !== '0',
    adaptiveMinIntervalMs = DEFAULT_ADAPTIVE_MIN_INTERVAL_MS,
    dryRun = process.env.DRY_RUN === '1',
    limit = 20,
    filterSelfSent = true,
    pendingStoreFile,
    archiveFile,
    batchStoreFile,
    schedulesConfig: schedulesConfigFile = path.join(process.cwd(), 'email-schedules.yaml'),
  } = options;

  // ── Store paths ─────────────────────────────────────────────────────────────
  const storeDir = pendingStoreFile
    ? path.dirname(pendingStoreFile)
    : path.join(os.homedir(), '.agently-mail-client');
  const cursorFile = path.join(storeDir, 'poll-cursor.json');

  // ── Cursor persistence ───────────────────────────────────────────────────────
  function loadCursor() {
    try {
      if (fs.existsSync(cursorFile)) {
        const { afterTimestamp } = JSON.parse(fs.readFileSync(cursorFile, 'utf8'));
        if (afterTimestamp) return afterTimestamp;
      }
    } catch (err) {
      process.stderr.write(`[email-bridge] Failed to load poll cursor: ${err.message}\n`);
    }
    return null;
  }

  function saveCursor(ts) {
    const tmp = `${cursorFile}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(storeDir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ afterTimestamp: ts }, null, 2), 'utf8');
      fs.renameSync(tmp, cursorFile);
    } catch (err) {
      process.stderr.write(`[email-bridge] Failed to save poll cursor: ${err.message}\n`);
      try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    }
  }

  // ── Core objects ─────────────────────────────────────────────────────────────
  const mail       = new AgentlyMailClient();
  const dispatcher = new ProfileDispatcher(profilesConfig);
  const pending    = new PendingStore(pendingStoreFile);
  const archive    = new MailArchive(
    archiveFile ||
    path.join(storeDir, 'mail-archive.jsonl'),
  );

  const aclCfg = new AclConfig({
    aclConfigFile,
    dynamicFile: path.join(storeDir, 'acl-dynamic.json'),
  });
  const acl      = new SenderAcl(aclCfg);
  const deniedLog = new DeniedLog(
    pendingStoreFile
      ? path.join(storeDir, 'denied-log.json')
      : undefined,
  );
  const admin = new AdminHandler(aclCfg, deniedLog, mail, { dryRun });

  // ── Batch mode ────────────────────────────────────────────────────────────────
  const batchCfg        = aclCfg._static?.batch_mode || {};
  const batchEnabled    = batchCfg.enabled === true;
  const batchIntervalMs = (batchCfg.collect_interval_hours || 2) * 60 * 60 * 1000;
  const batchTrustedSenders = aclCfg.instantReplySenders;

  const batchStore = new BatchStore(
    batchStoreFile ||
    path.join(storeDir, 'batch-queue.json'),
  );

  // dispatchAndReply is wired to batchHandler after creation (avoid circular init)
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

  // ── Dispatch core ─────────────────────────────────────────────────────────────
  const { dispatchAndReply, handleDenied, readAndArchive, log } = createDispatcher({
    mail, dispatcher, pending, archive, acl, aclCfg, deniedLog, dryRun,
  });
  _dispatchAndReplyRef = dispatchAndReply;

  // ── Startup logging ───────────────────────────────────────────────────────────
  const profileNames = dispatcher.profileNames();
  process.stderr.write(
    `[email-bridge] Loaded ${profileNames.length} profile(s): ${profileNames.join(', ')}\n`,
  );

  // ── Hot-reload watchers ───────────────────────────────────────────────────────
  let reloadTimer = null;
  let profilesWatcher = null;
  try {
    profilesWatcher = fs.watch(profilesConfig, () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { reloadTimer = null; dispatcher.reload(); }, 300);
    });
    profilesWatcher.on('error', () => {});
  } catch {}

  let aclReloadTimer = null;
  function scheduleAclReload() {
    if (aclReloadTimer) clearTimeout(aclReloadTimer);
    aclReloadTimer = setTimeout(() => {
      aclReloadTimer = null;
      try {
        aclCfg.reload();
        process.stderr.write(
          `[email-bridge] ACL config hot-reloaded: ${aclCfg.allowedSenders.length} allowed, ` +
          `${aclCfg.deniedSenders.length} denied, deny_action=${aclCfg.denyAction}\n`,
        );
      } catch (err) {
        process.stderr.write(`[email-bridge] Failed to reload ACL config: ${err.message}\n`);
      }
    }, 300);
  }

  let aclWatcher = null;
  let aclDynamicWatcher = null;
  try {
    if (aclConfigFile) {
      aclWatcher = fs.watch(aclConfigFile, scheduleAclReload);
      aclWatcher.on('error', () => {});
    }
  } catch {}

  // Watch the store directory for acl-dynamic.json changes.
  // Watching the file itself would miss the initial creation (file doesn't exist at startup).
  try {
    fs.mkdirSync(storeDir, { recursive: true });
    aclDynamicWatcher = fs.watch(storeDir, (event, filename) => {
      if (filename === 'acl-dynamic.json') scheduleAclReload();
    });
    aclDynamicWatcher.on('error', () => {});
  } catch {}

  // ── Startup auth check ────────────────────────────────────────────────────────
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

  // ── Poll ──────────────────────────────────────────────────────────────────────
  // Refresh ownAddresses lazily when empty (e.g. rate-limited at startup).
  // Retry at most once per 10 minutes to avoid burning RPM quota.
  let ownAddressRefreshAt = 0;
  const OWN_ADDR_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
  async function getOwnAddressesCached() {
    if (ownAddresses.size > 0) return ownAddresses;
    if (Date.now() - ownAddressRefreshAt < OWN_ADDR_REFRESH_INTERVAL_MS) return ownAddresses;
    ownAddressRefreshAt = Date.now();
    ownAddresses = await getOwnAddresses(mail);
    if (ownAddresses.size > 0) {
      process.stderr.write(
        `[email-bridge] Self-sent filter refreshed: ${[...ownAddresses].join(', ')}\n`,
      );
    }
    return ownAddresses;
  }

  const pollCallback = createPollHandler({
    aclCfg, acl, admin, batchHandler,
    pending, dispatchAndReply, handleDenied, readAndArchive,
    filterSelfSent,
    getOwnAddresses: getOwnAddressesCached,
    log,
    traceId: () => randomBytes(3).toString('hex'),
  });

  const savedCursor = loadCursor();
  if (savedCursor) {
    process.stderr.write(`[email-bridge] Resuming from cursor: ${savedCursor}\n`);
  }

  const poller = mail.poll(pollIntervalMs, pollCallback, {
    limit,
    afterTimestamp: savedCursor || undefined,
    saveCursor,
    adaptive: adaptivePolling,
    minIntervalMs: adaptiveMinIntervalMs,
  });

  // ── Retry sweep ───────────────────────────────────────────────────────────────
  const runRetrySweep = createRetrySweep({ pending, mail, dispatchAndReply, log });
  let retryTimer = null;
  // Save the initial setTimeout handle so stop() can cancel it before it fires.
  // Without this, calling stop() immediately after start leaks the interval forever.
  const retryInitTimer = setTimeout(() => {
    runRetrySweep();
    retryTimer = setInterval(runRetrySweep, pollIntervalMs);
  }, Math.floor(pollIntervalMs / 2));

  // ── Schedulers ────────────────────────────────────────────────────────────────
  admin.startReportScheduler();

  if (batchHandler) {
    batchHandler.start(batchIntervalMs);
    process.stderr.write(
      `[email-bridge] Batch mode: ON (interval=${batchCfg.collect_interval_hours || 2}h, ` +
      `trusted=${batchTrustedSenders.length > 0 ? batchTrustedSenders.join(', ') : 'none'})\n`,
    );
  }

  const scheduleRunner = new ScheduleRunner({
    configPath: schedulesConfigFile,
    dispatcher,
    mailClient: mail,
    builtinHandlers,
    dryRun,
  });
  scheduleRunner.start();

  // ── Graceful shutdown ─────────────────────────────────────────────────────────
  const stop = () => {
    poller.stop();
    admin.stopReportScheduler();
    if (batchHandler) batchHandler.stop();
    clearTimeout(retryInitTimer);
    if (retryTimer) clearInterval(retryTimer);
    scheduleRunner.stop();
    if (reloadTimer) clearTimeout(reloadTimer);
    if (profilesWatcher) { try { profilesWatcher.close(); } catch {} }
    if (aclReloadTimer) clearTimeout(aclReloadTimer);
    if (aclWatcher) { try { aclWatcher.close(); } catch {} }
    if (aclDynamicWatcher) { try { aclDynamicWatcher.close(); } catch {} }
  };

  process.on('SIGINT', () => {
    process.stderr.write('\n[email-bridge] Stopping...\n');
    stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => { stop(); process.exit(0); });

  return { stop };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  AgentlyMailClient,
  AgentlyMailError,
  ProfileDispatcher,
  PendingStore,
  MailArchive,
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
