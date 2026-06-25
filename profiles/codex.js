#!/usr/bin/env node
'use strict';
/**
 * codex Profile — wraps the OpenAI Codex CLI (`codex`)
 *
 * Event format (JSONL, one per line):
 *   {"type":"thread.started","thread_id":"<uuid>"}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{...}}
 *
 * Env vars:
 *   AGENT_MESSAGE        (P0) User message text
 *   AGENT_SESSION_ID     (P0) thread_id to resume (empty = new thread)
 *
 * Local test:
 *   AGENT_MESSAGE="hello" AGENT_SESSION_ID="" node codex.js
 */

const { createProfile } = require('../src/index');
const { spawnWithTimeout, withResumeFallback } = require('../src/spawn');
const { PROFILE_TIMEOUT_MS } = require('../src/constants');

/**
 * @param {string} message
 * @param {string} sessionId  thread_id or empty
 * @param {(chunk: string) => void} [onChunk]
 * @returns {Promise<{ sessionId: string, responseText: string }>}
 */
async function runCodex(message, sessionId, onChunk) {
  const args = ['exec'];
  if (sessionId) {
    args.push('resume', sessionId);
  }
  args.push(message, '--dangerously-bypass-approvals-and-sandbox', '--json');

  const chunks = [];
  let threadId = sessionId || '';
  let completed = false;

  const result = await spawnWithTimeout('codex', args, {
    timeoutMs: PROFILE_TIMEOUT_MS,
    onLine: (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }

      if (event.type === 'thread.started' && event.thread_id) {
        threadId = event.thread_id;
      } else if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        const text = event.item.text || '';
        if (text) {
          chunks.push(text);
          if (onChunk) onChunk(text);
        }
      } else if (event.type === 'turn.completed') {
        completed = true;
      }
    },
  });

  if (result.timedOut) {
    throw new Error(`codex timed out after ${PROFILE_TIMEOUT_MS / 1000}s`);
  }

  if (completed || chunks.length > 0) {
    return { sessionId: threadId, responseText: chunks.join('') };
  }

  const stderrTail = (result.stderr || '').trim().slice(-512);
  const reason = result.signal
    ? `killed by signal ${result.signal}`
    : `exited with code ${result.code}`;
  throw new Error(`codex ${reason}, no agent_message` + (stderrTail ? `\n${stderrTail}` : ''));
}

createProfile(async ({ message, sessionId, sendPartial }) => {
  const invoke = (sid) => runCodex(message, sid, sendPartial);
  const { sessionId: newSid } = await withResumeFallback(invoke, sessionId, 'codex');
  return { response: '', sessionId: newSid || undefined };
});
