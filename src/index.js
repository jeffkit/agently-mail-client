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
const {
  readAccountInfo,
  writeAccountInfo,
  ownAddressesFrom,
} = require('./account-info');

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
  const nextPollDueFile = path.join(storeDir, 'next-poll-due.json');

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

  // ── Next-poll-due persistence (resume cadence after restart) ─────────────────
  // 上次进程排定的下次轮询时间。重启时用它算出"还要等多久"，避免重启即 burst。
  function loadNextPollDue() {
    try {
      if (fs.existsSync(nextPollDueFile)) {
        const { dueMs } = JSON.parse(fs.readFileSync(nextPollDueFile, 'utf8'));
        if (Number.isFinite(dueMs)) return dueMs;
      }
    } catch {
      /* best-effort */
    }
    return null;
  }

  function saveNextPollDue(dueMs) {
    const tmp = `${nextPollDueFile}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(storeDir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ dueMs }, null, 2), 'utf8');
      fs.renameSync(tmp, nextPollDueFile);
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
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
  // 优先用本地持久化的账号信息（account-info.json），避免重启就立刻打一次上游 +me。
  // 仅当本地没有缓存时（首次运行 / 缓存丢失）才主动 +me 做 fail-fast 鉴权。
  const OWN_ADDR_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
  const OWN_ADDR_STALE_MS = 6 * 60 * 60 * 1000; // 6h
  let ownAddresses = new Set();
  let ownAddressRefreshAt = 0;
  let ownAddressLastFetchAt = 0;
  const cachedInfo = readAccountInfo(storeDir);
  if (cachedInfo) {
    ownAddresses = ownAddressesFrom(cachedInfo);
    ownAddressRefreshAt = Date.now(); // 已有缓存，先不必立刻再拉
    ownAddressLastFetchAt = Date.parse(cachedInfo.fetchedAt) || 0;
  }

  const adminList0 = aclCfg.adminSenders;
  const pollDesc0 = adaptivePolling
    ? `adaptive (${adaptiveMinIntervalMs / 1000}s–${pollIntervalMs / 1000}s)`
    : `${pollIntervalMs / 1000}s fixed`;
  const email0 = cachedInfo?.email || 'unknown';

  const writeStartupBanner = () => {
    process.stderr.write(
      `[email-bridge] Monitoring ${email0} every ${pollDesc0}\n` +
      `[email-bridge] Subject prefix routing: [profile-name], default=${dispatcher.config.default}\n` +
      (filterSelfSent ? `[email-bridge] Self-sent filter: ON (${[...ownAddresses].join(', ')})\n` : '') +
      (acl.isOpenAccess() ? '' : `[email-bridge] Sender ACL: ON (deny_action=${acl.denyAction})\n`) +
      (adminList0.length > 0 ? `[email-bridge] Admin senders: ${adminList0.join(', ')}\n` : '') +
      (aclConfigFile ? `[email-bridge] ACL config: ${aclConfigFile}\n` : '[email-bridge] ACL config: (none — open access)\n'),
    );
  };

  if (cachedInfo) {
    // 有本地缓存：直接出 banner，不打上游。鉴权交给第一次 poll 的 list 去验证。
    process.stderr.write(
      `[email-bridge] Using cached account info (${email0}, fetched ${cachedInfo.fetchedAt}); skipping startup +me.\n`,
    );
    writeStartupBanner();
  } else {
    // 无缓存：fail-fast 鉴权，成功则落盘供 dashboard 复用。
    (async () => {
      try {
        const me = await mail.me();
        writeAccountInfo(storeDir, me);
        ownAddressLastFetchAt = Date.now();
        const next = new Set();
        for (const alias of (me?.aliases || [])) {
          if (alias?.email) next.add(alias.email.toLowerCase());
        }
        ownAddresses = next;
        ownAddressRefreshAt = Date.now();
        const email = me?.aliases?.[0]?.email || 'unknown';
        process.stderr.write(
          `[email-bridge] Monitoring ${email} every ${pollDesc0}\n` +
          `[email-bridge] Subject prefix routing: [profile-name], default=${dispatcher.config.default}\n` +
          (filterSelfSent ? `[email-bridge] Self-sent filter: ON (${[...ownAddresses].join(', ')})\n` : '') +
          (acl.isOpenAccess() ? '' : `[email-bridge] Sender ACL: ON (deny_action=${acl.denyAction})\n`) +
          (adminList0.length > 0 ? `[email-bridge] Admin senders: ${adminList0.join(', ')}\n` : '') +
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
  }

  // ── Poll ──────────────────────────────────────────────────────────────────────
  // Refresh ownAddresses lazily when empty (e.g. rate-limited at startup),
  // or periodically (every 6h) even when populated, to keep account-info.json
  // fresh for the dashboard without it having to call upstream itself.
  async function getOwnAddressesCached() {
    const now = Date.now();
    const empty = ownAddresses.size === 0;
    const stale = now - ownAddressLastFetchAt > OWN_ADDR_STALE_MS;
    if (!empty && !stale) return ownAddresses;
    if (empty && now - ownAddressRefreshAt < OWN_ADDR_REFRESH_INTERVAL_MS) return ownAddresses;
    ownAddressRefreshAt = now;
    try {
      const me = await mail.me();
      writeAccountInfo(storeDir, me);
      ownAddressLastFetchAt = Date.now();
      // 直接从同一个 me() 返回值构造集合，避免再调一次 mail.me()
      const next = new Set();
      for (const alias of (me?.aliases || [])) {
        if (alias?.email) next.add(alias.email.toLowerCase());
      }
      if (next.size > 0) {
        ownAddresses = next;
        if (empty) {
          process.stderr.write(
            `[email-bridge] Self-sent filter refreshed: ${[...ownAddresses].join(', ')}\n`,
          );
        }
      }
    } catch {
      // 上游失败时保留现有集合（可能是空）；下次再试。
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

  // 计算首拍延迟：如果有持久化的"下次轮询时间"，就对齐它（仍在未来就等到那时，
  // 已过期就尽快但加一点抖动）；没有就给一个小的启动延迟，避免重启即打上游。
  const MIN_START_DELAY_MS = 2_000;
  const savedNextDue = loadNextPollDue();
  let startDelayMs;
  if (savedNextDue != null) {
    const delta = savedNextDue - Date.now();
    if (delta > 0) {
      startDelayMs = Math.min(delta, pollIntervalMs); // 对齐节奏，但不超过一个轮询周期
    } else {
      startDelayMs = MIN_START_DELAY_MS; // 错过了，尽快补一次但不瞬间打
    }
  } else {
    startDelayMs = Math.max(MIN_START_DELAY_MS, Math.min(10_000, pollIntervalMs));
  }
  process.stderr.write(
    `[email-bridge] First poll in ${Math.round(startDelayMs / 1000)}s (resume cadence)\n`,
  );

  const poller = mail.poll(pollIntervalMs, pollCallback, {
    limit,
    afterTimestamp: savedCursor || undefined,
    saveCursor,
    adaptive: adaptivePolling,
    minIntervalMs: adaptiveMinIntervalMs,
    startDelayMs,
    onSchedule: saveNextPollDue,
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
