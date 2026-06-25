#!/usr/bin/env node
'use strict';
/**
 * agy Profile — wraps the Antigravity (Google DeepMind) `agy` CLI
 *
 * Unlike the stream-json CLIs, agy:
 *  - Outputs plain text to stdout
 *  - Writes a conversation ID to its log file
 *  - Requires stdin to be closed immediately (non-interactive)
 *
 * Session management: parse "Created conversation <uuid>" from the log file.
 *
 * Env vars:
 *   AGENT_MESSAGE        (P0) User message text
 *   AGENT_SESSION_ID     (P0) Conversation UUID to resume
 *   AGY_MODEL            Override model
 *
 * Local test:
 *   AGENT_MESSAGE="hello" AGENT_SESSION_ID="" node agy.js
 */

const { createProfile } = require('../src/index');
const { spawnWithTimeout, withResumeFallback } = require('../src/spawn');
const { PROFILE_TIMEOUT_MS } = require('../src/constants');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * @param {string} message
 * @param {string} sessionId  conversation UUID or empty
 * @returns {Promise<{ response: string, sessionId: string }>}
 */
async function runAgy(message, sessionId) {
  const logPath = path.join(os.tmpdir(), `agy-${process.pid}-${Date.now()}.log`);
  const model = process.env.AGY_MODEL || '';

  const args = ['--dangerously-skip-permissions', '--log-file', logPath];
  if (model) args.push('--model', model);
  if (sessionId) args.push('--conversation', sessionId);
  args.push('-p', message);

  const result = await spawnWithTimeout('agy', args, {
    timeoutMs: PROFILE_TIMEOUT_MS,
  });

  if (result.timedOut) {
    try { fs.unlinkSync(logPath); } catch { /* ignore */ }
    throw new Error(`agy timed out after ${PROFILE_TIMEOUT_MS / 1000}s`);
  }

  if (result.code !== 0) {
    const stderrTail = (result.stderr || '').trim().slice(-512);
    try { fs.unlinkSync(logPath); } catch { /* ignore */ }
    const reason = result.signal
      ? `killed by signal ${result.signal}`
      : `exited with code ${result.code}`;
    throw new Error(`agy ${reason}` + (stderrTail ? `\n${stderrTail}` : ''));
  }

  const response = (result.stdout || '').trim();

  // Extract conversation ID from log file
  let newSessionId = sessionId || '';
  try {
    const log = fs.readFileSync(logPath, 'utf8');
    const m = log.match(/Created conversation ([a-f0-9-]{36})/i);
    if (m) newSessionId = m[1];
  } catch { /* log may not exist if agy skipped it */ }
  try { fs.unlinkSync(logPath); } catch { /* ignore */ }

  return { response, sessionId: newSessionId };
}

createProfile(async ({ message, sessionId }) => {
  const invoke = (sid) => runAgy(message, sid);
  const result = await withResumeFallback(invoke, sessionId, 'agy');
  return { response: result.response, sessionId: result.sessionId || undefined };
});
