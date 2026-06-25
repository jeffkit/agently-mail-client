'use strict';
/**
 * 公共 spawn 工具。
 *
 * - spawnWithTimeout(command, args, opts)  Promise 包装的 spawn + 超时 + stderr 收集
 * - withResumeFallback(invoke, sid, label)  session 失效降级重试
 *
 * 这两个函数以前在 profiles/_stream_json.js、codex.js、agy.js 各自手写。
 * dispatcher.js 的 _spawnProfile 也用到了 spawnWithTimeout。
 */

const { spawn } = require('child_process');
const readline = require('readline');

const { PROFILE_TIMEOUT_MS } = require('./constants');

/**
 * Spawn a child process with a hard timeout.
 *
 * 调用方可选：
 *   - opts.stdin       写入子进程 stdin 的字符串（写完关闭）
 *   - opts.timeoutMs   默认 PROFILE_TIMEOUT_MS
 *   - opts.env         子进程环境
 *   - opts.cwd         子进程工作目录
 *   - opts.onLine      按行回调 (line) => void（注意：onLine 模式下仍会
 *                      全量 buffer stdout 到 result.stdout，方便调用方做兜底）
 *
 * 永远 resolves（即使是子进程被信号 kill、非零退出、超时也不 reject）。
 * 调用方根据 result.code / result.signal / result.timedOut 判断成功失败。
 * 唯一 reject 的情况是 spawn 本身失败（command not found）。
 *
 * @returns {Promise<{ stdout: string, stderr: string, code: number|null, signal: string|null, timedOut: boolean }>}
 */
function spawnWithTimeout(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? PROFILE_TIMEOUT_MS;
    const env = opts.env;
    const cwd = opts.cwd;
    const onLine = opts.onLine;

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd,
      detached: false,
    });

    const stderrChunks = [];
    const stdoutChunks = [];
    let timedOut = false;
    let rl = null;

    if (opts.stdin != null && opts.stdin !== '') {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();

    child.stderr.on('data', (d) => stderrChunks.push(d));

    if (onLine) {
      rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => onLine(line));
    } else {
      child.stdout.on('data', (d) => stdoutChunks.push(d));
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      // 2s 内不退出再 SIGKILL（覆盖子进程忽略 SIGTERM 的情况）
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, 2000);
    }, timeoutMs);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (rl) rl.close();
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        code,
        signal,
        timedOut,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (timedOut) return;
      reject(err);
    });
  });
}

/**
 * Run with session-resume fallback.
 * If invocation with sessionId fails, retry with empty session.
 *
 * @param {(sid: string) => Promise<any>} invoke
 * @param {string} sessionId
 * @param {string} label  For error messages
 * @returns {Promise<any>}
 */
async function withResumeFallback(invoke, sessionId, label) {
  try {
    return await invoke(sessionId);
  } catch (err) {
    if (sessionId) {
      process.stderr.write(`[${label}] session ${sessionId} resume failed: ${err.message}\n`);
      return await invoke('');
    }
    throw err;
  }
}

module.exports = {
  spawnWithTimeout,
  withResumeFallback,
};
