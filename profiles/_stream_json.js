'use strict';
/**
 * _stream_json.js — shared helpers for CLIs that emit `--output-format stream-json`
 *
 * Handles: claude / codebuddy / cursor (all use the same event schema)
 *
 * Event schema:
 *   {"type":"system","session_id":"<uuid>",...}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}],...},...}
 *   {"type":"result","subtype":"success","result":"...","session_id":"<uuid>"}
 *
 * Returns { sessionId, responseText } where:
 *   - responseText: full response (for callers that do NOT stream)
 *   - All text is also emitted via onChunk during streaming
 */

const { spawnWithTimeout, withResumeFallback } = require('../src/spawn');
const { PROFILE_TIMEOUT_MS } = require('../src/constants');

/**
 * Invoke a stream-json CLI.
 *
 * @param {string}   command     e.g. 'claude', 'agent', 'codebuddy'
 * @param {string[]} args        Additional CLI args (NOT including --output-format)
 * @param {string}   message     Text to pass via -p or stdin
 * @param {'arg'|'stdin'} inputMode  'arg' = pass message via -p flag, 'stdin' = write to stdin
 * @param {(chunk: string) => void} [onChunk]  Called for each streamed text fragment
 * @returns {Promise<{ sessionId: string, responseText: string }>}
 */
async function streamJsonCli(command, args, message, inputMode, onChunk) {
  const finalArgs = [
    '--output-format', 'stream-json',
    ...args,
    ...(inputMode === 'arg' ? ['-p', message] : []),
  ];

  const chunks = [];
  let sessionId = '';
  let sawResultEvent = false;

  const result = await spawnWithTimeout(command, finalArgs, {
    timeoutMs: PROFILE_TIMEOUT_MS,
    stdin: inputMode === 'stdin' ? message : '',
    onLine: (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }

      if (event.type === 'assistant') {
        const blocks = event.message?.content ?? [];
        const text = blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('');
        if (text) {
          chunks.push(text);
          if (onChunk) onChunk(text);
        }
      } else if (event.type === 'result') {
        sawResultEvent = true;
        sessionId = event.session_id ?? '';
        // result.result may contain text when no assistant event preceded it
        const fallbackText = (event.result || '').trim();
        if (fallbackText && chunks.length === 0) {
          chunks.push(fallbackText);
          if (onChunk) onChunk(fallbackText);
        }
      }
    },
  });

  if (result.timedOut) {
    throw new Error(`${command} timed out after ${PROFILE_TIMEOUT_MS / 1000}s`);
  }

  if (sawResultEvent) {
    return { sessionId, responseText: chunks.join('') };
  }

  // 没收到 result 事件 —— 子进程异常退出
  const stderrTail = (result.stderr || '').trim().slice(-512);
  const reason = result.signal
    ? `killed by signal ${result.signal}`
    : `exited with code ${result.code}`;
  throw new Error(
    `${command} ${reason}, no result event` + (stderrTail ? `\n${stderrTail}` : ''),
  );
}

module.exports = {
  streamJsonCli,
  withResumeFallback,
};
