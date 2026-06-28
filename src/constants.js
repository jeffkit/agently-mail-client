'use strict';
/**
 * 集中管理跨模块共享的常量。
 *
 * 这里汇总了原先散落在 dispatcher.js / agently-mail.js / profiles/*.js /
 * pending-store.js 中的魔法数字，避免配置漂移（例如 profile 超时必须 ≥
 * dispatcher 父进程超时，否则 spawnSync 会提前杀掉子进程）。
 */

// Profile 子进程（dispatcher spawn）超时：5 分钟。
// 与 profiles/*.js 内部的 TIMEOUT_MS 保持一致。
const PROFILE_TIMEOUT_MS = 300_000;

// agently-cli 子进程的最大 stdout/stderr 缓冲。
const CLI_MAX_BUFFER = 10 * 1024 * 1024;

// dispatcher spawn profile 的 maxBuffer（profile 可能输出较多 streaming 事件）。
const PROFILE_MAX_BUFFER = 20 * 1024 * 1024;

// 邮件正文（送入 Profile 的 AGENT_MESSAGE）最大字符数，超过则截断。
const MAX_BODY_LENGTH = 8000;

// PendingStore 重试上限与冷却（参考 pending-store.js 注释）。
const PENDING_MAX_RETRIES = 5;
const PENDING_RETRY_COOLDOWN_MS = 60_000;

// 已回复邮件的本地保留时长（超出后 cleanup() 清理）。
const PENDING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// 默认轮询间隔（15 分钟）。
const DEFAULT_POLL_INTERVAL_MS = 900_000;

// 默认每轮 poll 拉取的邮件数。
const DEFAULT_POLL_LIMIT = 20;

// poll 去重 Set 的容量上限，避免长跑进程内存无限增长。
const POLL_SEEN_CACHE_SIZE = 5000;

// sessionId 各段长度限制。
const SESSION_ID_PROFILE_MAX = 40;
const SESSION_ID_HASH_LENGTH = 16; // SHA1 前 16 位

module.exports = {
  PROFILE_TIMEOUT_MS,
  CLI_MAX_BUFFER,
  PROFILE_MAX_BUFFER,
  MAX_BODY_LENGTH,
  PENDING_MAX_RETRIES,
  PENDING_RETRY_COOLDOWN_MS,
  PENDING_RETENTION_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_LIMIT,
  POLL_SEEN_CACHE_SIZE,
  SESSION_ID_PROFILE_MAX,
  SESSION_ID_HASH_LENGTH,
};
