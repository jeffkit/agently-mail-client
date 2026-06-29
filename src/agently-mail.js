'use strict';
/**
 * AgentlyMailClient — Node.js wrapper around the `agently-cli` binary.
 *
 * All operations spawn `agently-cli` as a child process and parse the
 * structured JSON output.  Write operations (send / reply / forward / trash)
 * implement the two-phase confirmation protocol automatically: the first call
 * returns a confirmation token; the client then re-runs with that token and
 * resolves only after the server confirms success.
 *
 * All methods are async — they wrap `spawnWithTimeout` so the Node.js event
 * loop is never blocked during CLI invocations.
 *
 * @example
 * const { AgentlyMailClient } = require('agently-mail-client');
 * const mail = new AgentlyMailClient();
 *
 * // Poll every 5 minutes, process each unread message
 * mail.poll(5 * 60_000, async (msg, client) => {
 *   const full = await client.read(msg.message_id);
 *   const reply = await myAI(full.body);
 *   await client.reply(msg.message_id, reply);
 * });
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { POLL_SEEN_CACHE_SIZE, CLI_TIMEOUT_MS } = require('./constants');
const { spawnWithTimeout } = require('./spawn');

// ---------------------------------------------------------------------------
// Simple bounded LRU set — caps the seen-ids cache so a long-running process
// doesn't accumulate every message_id it has ever seen.
// ---------------------------------------------------------------------------

class BoundedSet {
  constructor(max = POLL_SEEN_CACHE_SIZE) {
    this._max = max;
    this._map = new Map(); // insertion-ordered: oldest at index 0
  }
  has(key) { return this._map.has(key); }
  add(key) {
    if (this._map.has(key)) {
      // refresh insertion order
      this._map.delete(key);
    } else if (this._map.size >= this._max) {
      // evict oldest
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
    this._map.set(key, true);
  }
  get size() { return this._map.size; }
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

class AgentlyMailError extends Error {
  /**
   * @param {string} message
   * @param {number} exitCode
   * @param {string} [serverMessage]
   */
  constructor(message, exitCode, serverMessage) {
    super(message);
    this.name = 'AgentlyMailError';
    this.exitCode = exitCode;
    this.serverMessage = serverMessage;
  }
}

// ---------------------------------------------------------------------------
// RPM rate limiter — sliding-window token bucket
// ---------------------------------------------------------------------------
// The server enforces a hard 10 req/min quota per account. Without client-side
// throttling, a single poll batch that pulls N messages issues 1 + N*2 CLI
// calls (list + read + reply each), which bursts past 10/min and triggers 429
// exponential backoff (up to 4h). This limiter caps outbound CLI calls below
// the hard limit so bursts cannot self-inflict rate-limiting.
//
// Config: AGENTLY_RPM_LIMIT env var (default 8, 0 disables). Window is 60s.

const RPM_CAPACITY  = Math.max(0, parseInt(process.env.AGENTLY_RPM_LIMIT, 10) || 8);
const RPM_WINDOW_MS = 60_000;

const _rpmTimestamps = []; // request timestamps within the rolling window
let   _rpmWaiting    = false;

const _rpmStatsFile = path.join(os.homedir(), '.agently-mail-client', 'rpm-stats.json');
let   _rpmWriteScheduled = false;

function _sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function _evictExpired(now) {
  const cutoff = now - RPM_WINDOW_MS;
  while (_rpmTimestamps.length && _rpmTimestamps[0] <= cutoff) {
    _rpmTimestamps.shift();
  }
}

function getRpmStats() {
  const now = Date.now();
  _evictExpired(now);
  return {
    enabled:   RPM_CAPACITY > 0,
    capacity:  RPM_CAPACITY,
    windowMs:  RPM_WINDOW_MS,
    recent:    _rpmTimestamps.length,
    available: Math.max(0, RPM_CAPACITY - _rpmTimestamps.length),
    waiting:   _rpmWaiting,
  };
}

// Persist live stats to disk so the dashboard (a separate process) can render
// the bridge's real-time token bucket. Debounced — at most one write per 500ms.
function _persistRpmStats() {
  if (RPM_CAPACITY <= 0 || _rpmWriteScheduled) return;
  _rpmWriteScheduled = true;
  setTimeout(() => {
    _rpmWriteScheduled = false;
    try {
      fs.mkdirSync(path.dirname(_rpmStatsFile), { recursive: true });
      const payload = { ...getRpmStats(), updatedAt: new Date().toISOString() };
      const tmp = `${_rpmStatsFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, _rpmStatsFile);
    } catch {
      // stats persistence is best-effort; never let it break mail processing
    }
  }, 500);
}

/**
 * Block until an outbound CLI call may proceed under the RPM cap.
 * Sliding-window: keeps at most `RPM_CAPACITY` calls in any 60s window.
 */
async function throttleRpm() {
  if (RPM_CAPACITY <= 0) return;
  for (;;) {
    const now = Date.now();
    _evictExpired(now);
    if (_rpmTimestamps.length < RPM_CAPACITY) {
      _rpmTimestamps.push(now);
      _persistRpmStats();
      return;
    }
    // Window saturated — wait until the oldest call ages out, then recheck.
    const waitMs = (_rpmTimestamps[0] + RPM_WINDOW_MS) - now + 1;
    _rpmWaiting = true;
    await _sleep(Math.max(waitMs, 10));
    _rpmWaiting = false;
  }
}

// ---------------------------------------------------------------------------
// Low-level CLI runner (async — never blocks the event loop)
// ---------------------------------------------------------------------------

/**
 * Run `agently-cli <args>` and return parsed JSON data.
 * Throws AgentlyMailError on non-zero exit codes or spawn failure.
 *
 * @param {string[]} args
 * @returns {Promise<unknown>} data field from the JSON envelope
 */
async function runCli(args) {
  await throttleRpm();
  let result;
  try {
    result = await spawnWithTimeout('agently-cli', args, { timeoutMs: CLI_TIMEOUT_MS });
  } catch (err) {
    throw new AgentlyMailError(`Failed to spawn agently-cli: ${err.message}`, -1);
  }

  if (result.timedOut) {
    throw new AgentlyMailError(
      `agently-cli timed out after ${CLI_TIMEOUT_MS}ms (args: ${args.slice(0, 3).join(' ')})`,
      -1,
    );
  }

  const exitCode = result.code ?? -1;
  let envelope;
  try {
    envelope = JSON.parse(result.stdout || '{}');
  } catch {
    throw new AgentlyMailError(
      `agently-cli returned non-JSON output (exit ${exitCode}): ${result.stdout?.slice(0, 200)}`,
      exitCode,
    );
  }

  if (exitCode !== 0) {
    const msg =
      envelope?.error?.message || envelope?.message || `exit code ${exitCode}`;
    throw new AgentlyMailError(
      `agently-cli error (exit ${exitCode}): ${msg}`,
      exitCode,
      msg,
    );
  }

  return envelope.data;
}

// ---------------------------------------------------------------------------
// Two-phase confirmation helper
// ---------------------------------------------------------------------------

/**
 * Execute a write command that requires two-phase confirmation.
 * First call returns a confirmation_token; we automatically re-run with it.
 *
 * @param {string[]} args  CLI args WITHOUT --confirmation-token
 * @returns {Promise<unknown>} final data from the confirmed call
 */
async function runConfirmed(args) {
  // Phase 1 — get confirmation token
  const phase1 = await runCli(args);

  // Some commands may succeed without confirmation (e.g. dry-run)
  if (!phase1?.confirmation_token) {
    return phase1;
  }

  // Phase 2 — confirm with token
  return runCli([...args, '--confirmation-token', phase1.confirmation_token]);
}

// ---------------------------------------------------------------------------
// AgentlyMailClient
// ---------------------------------------------------------------------------

class AgentlyMailClient {
  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  /**
   * List messages in a folder.
   *
   * @param {object} [options]
   * @param {'inbox'|'sent'|'trash'|'spam'} [options.dir='inbox']
   * @param {number} [options.limit=10]
   * @param {string} [options.cursor]
   * @param {string} [options.after]   ISO date string
   * @param {string} [options.before]  ISO date string
   * @param {boolean} [options.hasAttachments]
   * @param {boolean} [options.isUnread]
   * @returns {{ messages: object[], pagination: object }}
   */
  async list(options = {}) {
    const args = ['message', '+list'];
    if (options.dir) args.push('--dir', options.dir);
    if (options.limit != null) args.push('--limit', String(options.limit));
    if (options.cursor) args.push('--cursor', options.cursor);
    if (options.after) args.push('--after', options.after);
    if (options.before) args.push('--before', options.before);
    if (options.hasAttachments) args.push('--has-attachments');
    if (options.isUnread) args.push('--is-unread');
    const data = await runCli(args);
    return { messages: data?.data ?? [], pagination: data?.pagination ?? {} };
  }

  /**
   * List only unread messages in the inbox.
   *
   * @param {number} [limit=20]
   * @returns {object[]}
   */
  async listUnread(limit = 20) {
    return (await this.list({ isUnread: true, limit })).messages;
  }

  /**
   * Read a single message in full (body + attachments).
   *
   * @param {string} messageId  msg_xxx
   * @returns {object}
   */
  async read(messageId) {
    return runCli(['message', '+read', '--id', messageId]);
  }

  /**
   * Search messages with keyword and optional filters.
   *
   * @param {string} query
   * @param {object} [options]
   * @param {'SEARCH_IN_ALL'|'SEARCH_IN_SUBJECT'|'SEARCH_IN_CONTENT'} [options.searchIn]
   * @param {string} [options.from]
   * @param {string} [options.to]
   * @param {'inbox'|'sent'|'trash'|'spam'} [options.dir]
   * @param {string} [options.after]
   * @param {string} [options.before]
   * @param {boolean} [options.hasAttachments]
   * @param {boolean} [options.isUnread]
   * @param {number} [options.limit]
   * @param {string} [options.cursor]
   * @returns {{ messages: object[], pagination: object }}
   */
  async search(query, options = {}) {
    const args = ['message', '+search', '--q', query];
    if (options.searchIn) args.push('--search-in', options.searchIn);
    if (options.from) args.push('--from', options.from);
    if (options.to) args.push('--to', options.to);
    if (options.dir) args.push('--dir', options.dir);
    if (options.after) args.push('--after', options.after);
    if (options.before) args.push('--before', options.before);
    if (options.hasAttachments) args.push('--has-attachments');
    if (options.isUnread) args.push('--is-unread');
    if (options.limit != null) args.push('--limit', String(options.limit));
    if (options.cursor) args.push('--cursor', options.cursor);
    const data = await runCli(args);
    return { messages: data?.data ?? [], pagination: data?.pagination ?? {} };
  }

  /**
   * Get current user info and alias list.
   *
   * @returns {object}
   */
  async me() {
    return runCli(['+me']);
  }

  // -------------------------------------------------------------------------
  // Write operations (two-phase confirmation handled automatically)
  // -------------------------------------------------------------------------

  /**
   * Send a new email.
   *
   * @param {string|string[]} to         Recipient(s)
   * @param {string}          subject
   * @param {string}          body
   * @param {object}          [options]
   * @param {string|string[]} [options.cc]
   * @param {string|string[]} [options.bcc]
   * @param {'plain'|'html'}  [options.bodyFormat='plain']
   * @param {string[]}        [options.attachments]  Relative file paths
   * @returns {object}
   */
  async send(to, subject, body, options = {}) {
    const args = ['message', '+send', '--subject', subject, '--body', body];
    const recipients = Array.isArray(to) ? to : [to];
    for (const r of recipients) args.push('--to', r);
    if (options.cc) {
      const ccs = Array.isArray(options.cc) ? options.cc : [options.cc];
      for (const c of ccs) args.push('--cc', c);
    }
    if (options.bcc) {
      const bccs = Array.isArray(options.bcc) ? options.bcc : [options.bcc];
      for (const b of bccs) args.push('--bcc', b);
    }
    if (options.bodyFormat === 'html') args.push('--body-format', 'html');
    if (options.attachments) {
      for (const a of options.attachments) args.push('--attachment', a);
    }
    return runConfirmed(args);
  }

  /**
   * Reply to a message.
   *
   * @param {string} messageId  msg_xxx
   * @param {string} body
   * @param {object} [options]
   * @param {boolean}         [options.replyAll]
   * @param {string|string[]} [options.cc]
   * @param {string|string[]} [options.bcc]
   * @param {'plain'|'html'}  [options.bodyFormat='plain']
   * @param {string[]}        [options.attachments]
   * @returns {object}
   */
  async reply(messageId, body, options = {}) {
    const args = ['message', '+reply', '--id', messageId, '--body', body];
    if (options.replyAll) args.push('--reply-all');
    if (options.cc) {
      const ccs = Array.isArray(options.cc) ? options.cc : [options.cc];
      for (const c of ccs) args.push('--cc', c);
    }
    if (options.bcc) {
      const bccs = Array.isArray(options.bcc) ? options.bcc : [options.bcc];
      for (const b of bccs) args.push('--bcc', b);
    }
    if (options.bodyFormat === 'html') args.push('--body-format', 'html');
    if (options.attachments) {
      for (const a of options.attachments) args.push('--attachment', a);
    }
    return runConfirmed(args);
  }

  /**
   * Forward a message to new recipients.
   *
   * @param {string}          messageId  msg_xxx
   * @param {string|string[]} to
   * @param {string}          [body]
   * @param {object}          [options]
   * @param {string|string[]} [options.cc]
   * @param {string|string[]} [options.bcc]
   * @param {'plain'|'html'}  [options.bodyFormat='plain']
   * @param {boolean}         [options.includeAttachments]
   * @param {string[]}        [options.attachments]
   * @returns {object}
   */
  async forward(messageId, to, body, options = {}) {
    const recipients = Array.isArray(to) ? to : [to];
    const args = ['message', '+forward', '--id', messageId];
    for (const r of recipients) args.push('--to', r);
    if (body) args.push('--body', body);
    if (options.cc) {
      const ccs = Array.isArray(options.cc) ? options.cc : [options.cc];
      for (const c of ccs) args.push('--cc', c);
    }
    if (options.bcc) {
      const bccs = Array.isArray(options.bcc) ? options.bcc : [options.bcc];
      for (const b of bccs) args.push('--bcc', b);
    }
    if (options.bodyFormat === 'html') args.push('--body-format', 'html');
    if (options.includeAttachments) args.push('--include-attachments');
    if (options.attachments) {
      for (const a of options.attachments) args.push('--attachment', a);
    }
    return runConfirmed(args);
  }

  /**
   * Move a message to trash (soft delete, 30-day retention).
   *
   * @param {string} messageId  msg_xxx
   * @returns {object}
   */
  async trash(messageId) {
    return runConfirmed(['message', '+trash', '--id', messageId]);
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  /**
   * Poll for new inbox messages using a time-cursor strategy with adaptive interval.
   *
   * Unlike the previous unread-flag approach, this method uses `--after <timestamp>`
   * so that messages are never missed due to external read operations (e.g. manual
   * `agently-cli message +read`, reading in another client, or a crash mid-processing).
   *
   * **Adaptive interval** (when `options.adaptive` is enabled, default: true):
   *   - New emails found  → next poll after `minIntervalMs` (stay alert)
   *   - Empty poll        → next poll after `currentInterval × stepFactor` (cool down)
   *   - Idle too long     → interval is capped at `intervalMs` (the configured max)
   *   This keeps the bridge responsive during active periods while respecting rate limits
   *   during quiet ones.  The API limit is 10 req/min; `minIntervalMs` defaults to 60 s.
   *
   * De-duplication: a BoundedSet of seen message_ids prevents the same message from
   * being dispatched twice within one process lifetime (the server may return messages
   * whose created_at equals the cursor boundary).
   *
   * @param {number} intervalMs  Maximum (base) poll interval in ms
   * @param {(msg: object, client: AgentlyMailClient) => Promise<void>} handler
   * @param {object} [options]
   * @param {number}  [options.limit=20]           Max messages per poll cycle
   * @param {string}  [options.afterTimestamp]     Initial cursor (ISO 8601); defaults to now
   * @param {(ts: string) => void} [options.saveCursor]  Persist cursor after each batch
   * @param {boolean} [options.adaptive=true]      Enable adaptive interval (default true)
   * @param {number}  [options.minIntervalMs=60000] Min interval when emails are found
   * @param {number}  [options.stepFactor=1.5]     Idle cool-down multiplier per empty tick
   * @returns {{ stop: () => void, currentIntervalMs: () => number }}
   */
  poll(intervalMs, handler, options = {}) {
    const limit            = options.limit ?? 20;
    const adaptive         = options.adaptive !== false; // default true
    const minIntervalMs    = options.minIntervalMs ?? 60_000;  // 1 min floor
    const stepFactor       = options.stepFactor ?? 1.5;
    const maxIntervalMs    = intervalMs; // configured value is the ceiling

    // Start from now if no saved cursor: don't reprocess the entire inbox on first run
    let afterTimestamp = options.afterTimestamp || new Date().toISOString();
    const saveCursor   = options.saveCursor || null;
    const seenIds      = new BoundedSet();
    let stopped        = false;
    let timer          = null;
    let ticking        = false; // mutex: skip new tick if previous is still running

    // Current adaptive interval — starts at maxIntervalMs (conservative on start)
    let currentInterval = maxIntervalMs;

    // Exponential backoff state for 429 rate-limit responses.
    // Resets to 0 on any successful poll; caps at 4 doublings (16× interval).
    let backoffLevel = 0;
    const BACKOFF_MAX = 4;

    const tick = async () => {
      if (stopped) return;
      if (ticking) {
        // Previous tick is still running (slow handler / AI profile took too long).
        // Schedule retry instead of overlapping — do NOT reset the adaptive interval.
        timer = setTimeout(tick, currentInterval);
        return;
      }
      ticking = true;
      let foundMessages = false;
      try {
        const { messages } = await this.list({ after: afterTimestamp, limit, dir: 'inbox' });
        // Sort ascending by created_at so we process oldest-first and advance cursor correctly
        messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

        // Successful poll — reset rate-limit backoff
        if (backoffLevel > 0) {
          process.stderr.write(`[agently-mail] Rate limit cleared, resuming adaptive interval.\n`);
          backoffLevel = 0;
        }

        foundMessages = messages.length > 0;

        let latestTimestamp = afterTimestamp;
        for (const msg of messages) {
          if (stopped) break;
          if (seenIds.has(msg.message_id)) continue;
          seenIds.add(msg.message_id);

          try {
            await handler(msg, this);
          } catch (err) {
            process.stderr.write(
              `[agently-mail] handler error for ${msg.message_id}: ${err?.message || err}\n`,
            );
          }

          // Advance cursor past this message
          if (msg.created_at && msg.created_at > latestTimestamp) {
            latestTimestamp = msg.created_at;
          }
        }

        // Move cursor forward so next poll only fetches newer messages.
        // We add 1ms to avoid re-fetching the last message on the boundary.
        if (messages.length > 0 && latestTimestamp >= afterTimestamp) {
          afterTimestamp = new Date(new Date(latestTimestamp).getTime() + 1).toISOString();
          if (saveCursor) saveCursor(afterTimestamp);
        }
      } catch (err) {
        const isRateLimit = /429|rate.?limit/i.test(err?.message || '');
        if (isRateLimit) {
          backoffLevel = Math.min(backoffLevel + 1, BACKOFF_MAX);
          const backoffMs = maxIntervalMs * Math.pow(2, backoffLevel);
          process.stderr.write(
            `[agently-mail] Rate limited (429), backoff level ${backoffLevel}: next poll in ${Math.round(backoffMs / 1000)}s\n`,
          );
          if (!stopped) timer = setTimeout(tick, backoffMs);
          return;
        }
        process.stderr.write(`[agently-mail] poll error: ${err?.message || err}\n`);
      } finally {
        ticking = false;
      }
      if (!stopped) {
        if (adaptive) {
          if (foundMessages) {
            // New emails: stay alert, poll sooner
            currentInterval = minIntervalMs;
          } else {
            // Idle: gradually cool down toward maxIntervalMs
            currentInterval = Math.min(Math.round(currentInterval * stepFactor), maxIntervalMs);
          }
          process.stderr.write(
            `[agently-mail] Next poll in ${Math.round(currentInterval / 1000)}s` +
            (foundMessages ? ' (active)' : ' (idle)') + '\n',
          );
        } else {
          currentInterval = maxIntervalMs;
        }
        timer = setTimeout(tick, currentInterval);
      }
    };

    // Start immediately
    tick();

    return {
      stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
      /** Returns the current adaptive interval in milliseconds. */
      currentIntervalMs() { return currentInterval; },
    };
  }
}

module.exports = { AgentlyMailClient, AgentlyMailError, getRpmStats };
