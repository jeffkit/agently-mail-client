// Type definitions for agently-mail-client
// Covers all public exports from src/index.js

export { AgentlyMailClient, AgentlyMailError } from './agently-mail';

// ---------------------------------------------------------------------------
// Profile / Dispatcher
// ---------------------------------------------------------------------------

export interface ProfileConfig {
  command: string;
  args?: string[];
  trigger?: string;
  description?: string;
  workdir?: string;
  timeout_ms?: number;
  system_prompt?: string;
}

export interface ProfilesConfig {
  default: string;
  profiles: Record<string, ProfileConfig>;
}

export interface DispatchResult {
  response: string;
  profileName: string;
}

export interface ResolveResult {
  profileName: string;
  profileConfig: ProfileConfig;
  cleanSubject: string;
}

export class ProfileDispatcher {
  config: ProfilesConfig;
  configPath: string;
  configDir: string;

  constructor(configPath: string);

  /** List configured profile names. */
  profileNames(): string[];

  /** Reload profiles config from disk (hot-reload support). */
  reload(): void;

  /** Resolve profile from email subject. */
  resolveProfile(subject: string): ResolveResult;

  /** Dispatch a full message to the resolved Profile and return the response. */
  dispatch(fullMsg: object, dryRun?: boolean): Promise<DispatchResult>;

  /** Dispatch a raw string message to a named profile (used by ScheduleRunner). */
  dispatchRaw(profileName: string, message: string, sessionId?: string, dryRun?: boolean): Promise<DispatchResult>;
}

/** Convert Markdown text to sanitised HTML suitable for email replies. */
export function convertMarkdownToHtml(markdown: string): string;

// ---------------------------------------------------------------------------
// ACL
// ---------------------------------------------------------------------------

export interface AclStaticConfig {
  allowed_senders?: string[];
  denied_senders?: string[];
  admin_senders?: string[];
  instant_reply_senders?: string[];
  deny_action?: 'silent' | 'notify';
  deny_message?: string;
  profile_acl?: Record<string, { allowed?: string[]; denied?: string[] }>;
  batch_mode?: BatchModeConfig;
}

export interface BatchModeConfig {
  enabled?: boolean;
  collect_interval_hours?: number;
  ai_profile?: string;
}

export interface AclDynamicSnapshot {
  allowed: string[];
  denied: string[];
}

export class AclConfig {
  allowedSenders: string[];
  deniedSenders: string[];
  adminSenders: string[];
  instantReplySenders: string[];
  denyAction: 'silent' | 'notify';
  denyMessage: string | null;

  constructor(opts?: { aclConfigFile?: string | null; dynamicFile?: string });

  /** Hot-reload: refresh _static and merge with dynamic rules. */
  reload(): void;

  /** Apply allow rules to dynamic override file. */
  dynamicAllow(addresses: string[]): void;

  /** Apply deny rules to dynamic override file. */
  dynamicDeny(addresses: string[]): void;

  /** Remove addresses from dynamic lists. */
  dynamicReset(addresses: string[]): void;

  /** Return a snapshot of the current dynamic state. */
  dynamicSnapshot(): AclDynamicSnapshot;
}

export type AclResult = 'allow' | 'deny';

export class SenderAcl {
  denyAction: 'silent' | 'notify';

  constructor(aclConfig: AclConfig);

  /** True when no allow-list is configured (open access). */
  isOpenAccess(): boolean;

  /** True if the address is in admin_senders. */
  isAdmin(email: string): boolean;

  /**
   * Check global sender permission.
   * Returns 'allow' or 'deny'.
   */
  check(email: string): AclResult;

  /**
   * Check per-profile ACL (called after global check passes).
   * Returns 'allow' or 'deny'.
   */
  checkProfile(profileName: string, email: string): AclResult;
}

// ---------------------------------------------------------------------------
// Pending / Retry store
// ---------------------------------------------------------------------------

export interface PendingEntry {
  message_id: string;
  subject: string;
  from_email: string;
  added_at: string;
  replied: boolean;
  replied_at: string | null;
  retries: number;
  last_error: string | null;
  last_failed_at: string | null;
}

export class PendingStore {
  constructor(storeFile?: string);

  /** Add a message summary to the store (idempotent). */
  add(msgSummary: object): void;

  /** Mark a message as replied. */
  markReplied(messageId: string): void;

  /** Increment retry counter and record last error. */
  markFailed(messageId: string, error?: string): void;

  /** Return messages due for retry (respects cooldown and max retries). */
  getPending(): PendingEntry[];

  /** Remove old replied entries beyond the retention window. */
  cleanup(): void;
}

// ---------------------------------------------------------------------------
// Mail archive
// ---------------------------------------------------------------------------

export interface MailMessage {
  message_id: string;
  thread_root: string;
  direction: 'in' | 'out';
  from?: object;
  to?: object[];
  cc?: object[] | null;
  subject?: string;
  body_html?: string | null;
  body_text?: string | null;
  references?: string[] | null;
  created_at: string;
  archived_at: string;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  direction?: 'in' | 'out';
  q?: string;
}

export interface ThreadSummary {
  thread_root: string;
  subject: string;
  participants: string[];
  last_at: string;
  count: number;
  has_unread?: boolean;
}

export class MailArchive {
  constructor(archiveFile?: string);

  /** Archive an incoming message. Duplicate message_ids are skipped. */
  archiveIncoming(fullMsg: object): void;

  /** Archive an outgoing reply/send. */
  archiveOutgoing(opts: Partial<MailMessage>): void;

  /** List archived messages with optional filtering and pagination. */
  list(opts?: ListOptions): MailMessage[];

  /** List conversation threads grouped by thread_root. */
  listThreads(opts?: { limit?: number; offset?: number; q?: string }): ThreadSummary[];

  /** Return all messages in a thread. */
  getThread(threadRoot: string): MailMessage[];
}

/** Compute the thread root ID from a message object. */
export function computeThreadRoot(msg: object): string;

// ---------------------------------------------------------------------------
// Denied log
// ---------------------------------------------------------------------------

export interface DeniedEntry {
  message_id: string;
  subject: string;
  from: object;
  received_at: string;
  reason: string;
  reported: boolean;
}

export class DeniedLog {
  constructor(logFile?: string);

  /** Record a denied message. */
  record(msg: object, reason: string): void;

  /** Return entries that have not been included in a report yet. */
  getUnreported(): DeniedEntry[];

  /** Mark entries as reported. */
  markReported(ids: string[]): void;

  /** Remove old reported entries beyond the retention window. */
  cleanup(): void;
}

// ---------------------------------------------------------------------------
// Admin handler
// ---------------------------------------------------------------------------

export class AdminHandler {
  constructor(
    aclConfig: AclConfig,
    deniedLog: DeniedLog,
    mailClient: object,
    opts?: { dryRun?: boolean },
  );

  /** True if the message body contains at least one recognisable admin command. */
  hasCommands(body: string): boolean;

  /** Parse, execute commands and send a reply summary. */
  executeCommands(messageId: string, body: string, fromEmail: string): Promise<void>;

  /** Start the periodic inspection-report scheduler. */
  startReportScheduler(): void;

  /** Stop the inspection-report scheduler. */
  stopReportScheduler(): void;
}

// ---------------------------------------------------------------------------
// Batch mode
// ---------------------------------------------------------------------------

export interface BatchEntry {
  message_id: string;
  subject: string;
  from_email: string;
  from_name: string;
  created_at: string;
  queued_at: string;
  body_snippet: string;
  status: 'queued' | 'replied' | 'skipped' | 'failed';
  resolved_at: string | null;
  error: string | null;
}

export class BatchStore {
  constructor(storeFile?: string);

  enqueue(msgSummary: object, bodySnippet?: string): void;
  markReplied(messageId: string): void;
  markSkipped(messageId: string): void;
  markFailed(messageId: string, error?: string): void;
  getQueued(): BatchEntry[];
  getAll(opts?: { since?: string }): BatchEntry[];
  get(messageId: string): BatchEntry | null;
  cleanup(): void;
  setLastReportAt(isoTimestamp: string): void;
  getLastReportAt(): string | null;
}

export interface BatchHandlerOptions {
  batchStore: BatchStore;
  aclConfig: AclConfig;
  mailClient: object;
  dispatcher: ProfileDispatcher;
  dispatchAndReply: (...args: any[]) => Promise<boolean>;
  batchConfig?: BatchModeConfig;
  dryRun?: boolean;
}

export class BatchHandler {
  constructor(opts: BatchHandlerOptions);

  start(batchIntervalMs: number): void;
  stop(): void;
  enqueue(msgSummary: object, fullMsg?: object): void;
  isBatchReply(subject: string): boolean;
  handleOwnerReply(messageId: string, fullMsg: object, fromEmail: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Schedule runner
// ---------------------------------------------------------------------------

export interface ScheduleTask {
  name: string;
  cron: string;
  type?: 'profile' | 'builtin';
  enabled?: boolean;
  timezone?: string;
  profile?: string;
  message?: string;
  to?: string;
  subject?: string;
  handler?: string;
}

export interface ScheduleRunnerOptions {
  configPath: string;
  dispatcher: ProfileDispatcher;
  mailClient: object;
  builtinHandlers?: Record<string, (task: ScheduleTask, ctx: { mail: object; dryRun: boolean }) => Promise<void>>;
  dryRun?: boolean;
}

export class ScheduleRunner {
  constructor(opts: ScheduleRunnerOptions);
  start(): void;
  stop(): void;
}

// ---------------------------------------------------------------------------
// createEmailBridge
// ---------------------------------------------------------------------------

export interface EmailBridgeOptions {
  /** Path to email-profiles.yaml (default: ./email-profiles.yaml) */
  profilesConfig?: string;
  /** Path to email-acl.yaml (optional; absent = open access) */
  aclConfig?: string;
  /** Poll interval in milliseconds (default: 900_000 = 15 min) */
  pollIntervalMs?: number;
  /** Enable adaptive polling that speeds up when new mail arrives (default: true) */
  adaptivePolling?: boolean;
  /** Minimum adaptive poll interval in ms (default: 60_000 = 60 s) */
  adaptiveMinIntervalMs?: number;
  /** Skip actual email replies (default: false) */
  dryRun?: boolean;
  /** Max unread emails per poll cycle (default: 20) */
  limit?: number;
  /** Skip emails sent by the bridge's own account (default: true) */
  filterSelfSent?: boolean;
  /** Custom path for pending-store JSON file */
  pendingStoreFile?: string;
  /** Custom path for mail-archive JSONL file */
  archiveFile?: string;
  /** Custom path for batch-queue JSON file */
  batchStoreFile?: string;
  /** Path to email-schedules.yaml (default: ./email-schedules.yaml) */
  schedulesConfig?: string;
}

export interface BridgeController {
  stop(): void;
}

/**
 * Start the email bridge daemon.
 * Polls the mailbox, routes each unread email to a Profile, and replies.
 */
export function createEmailBridge(options?: EmailBridgeOptions): BridgeController;

/**
 * Create an AgentProc P0-compatible profile entry point.
 * Thin re-export of `createProfile` from the `agentproc` package.
 */
export function createProfile(opts: object): void;
