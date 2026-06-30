'use strict';
/**
 * builtin-handlers.js — 内置定时任务 handler 集合
 *
 * 每个 handler 签名：async (task, ctx) => void
 *   task  yaml 里该任务的完整配置对象
 *   ctx   { mail: AgentlyMailClient, dryRun: boolean }
 *
 * 临时任务完成后，从 yaml 删配置、从这里删函数即可，其他模块零改动。
 */

const fs = require('fs');

// 通知邮件发送失败时的最大重试次数（每 10 分钟一次 → 上限约 1 小时）
const NOTIFY_MAX_RETRIES = 6;

/**
 * 监听 bridge 日志里的 "Rate limit cleared" 信号，限流解除后发一封通知邮件。
 *
 * 设计要点（加固版）：
 *  - 检测与发送解耦：扫到信号先置 pending，发送失败保留 pending 下次 tick 重试，
 *    避免信号被消费后发送失败导致通知永久丢失。
 *  - 每次解除都通知：发送成功后把偏移重置到文件末尾，继续监听下一次"限流→解除"，
 *    而不是只通知一次就自禁用。
 *  - 日志截断自愈：文件变短（/tmp 被清等）时重置偏移，避免卡死失明。
 *
 * yaml 配置示例：
 *   - name: rate-limit-recovery
 *     cron: "* /10 * * * *"
 *     type: builtin
 *     handler: rate-limit-recovery
 *     log_file: /tmp/agently-mail-bridge.log
 *     notify_to: bbmyth@gmail.com
 *     enabled: true
 */
async function rateLimitRecovery(task, ctx) {
  const { mail, dryRun } = ctx;
  const logFile = task.log_file || '/tmp/agently-mail-bridge.log';
  const notifyTo = task.notify_to;
  const SIGNAL = 'Rate limit cleared';

  if (!notifyTo) {
    process.stderr.write('[builtin:rate-limit-recovery] notify_to not configured, skipping.\n');
    return;
  }

  // 每个任务一份状态：{ offset, pending, pendingAt, retries }
  if (!rateLimitRecovery._state) rateLimitRecovery._state = {};
  const state = rateLimitRecovery._state;
  const key = task.name;
  if (!(key in state)) {
    // 首次运行：记录当前文件大小，只监听此后新增的行。
    state[key] = {
      offset: fs.existsSync(logFile) ? fs.statSync(logFile).size : 0,
      pending: false,
      pendingAt: null,
      retries: 0,
    };
    return;
  }
  const s = state[key];
  const tag = `[builtin:rate-limit-recovery]`;

  // ── 1. 尾随日志找信号（仅在未处于待发送状态时）──────────────────────────
  if (!s.pending) {
    try {
      const stat = fs.statSync(logFile);
      if (stat.size < s.offset) {
        // 日志被截断/轮转（/tmp 清空等）：从文件头重新扫描。
        // 截断后通常是全新内容，重扫不会误报；即使残留旧信号行最多多发一次通知。
        s.offset = 0;
      }
      if (stat.size > s.offset) {
        const fd = fs.openSync(logFile, 'r');
        const buf = Buffer.alloc(stat.size - s.offset);
        fs.readSync(fd, buf, 0, buf.length, s.offset);
        fs.closeSync(fd);
        s.offset = stat.size;
        if (buf.toString('utf8').includes(SIGNAL)) {
          s.pending = true;
          s.pendingAt = new Date().toISOString();
          s.retries = 0;
          process.stderr.write(
            `${tag} Rate limit cleared detected at ${s.pendingAt}. Sending notification.\n`,
          );
        }
      }
    } catch (err) {
      process.stderr.write(`${tag} log read error: ${err.message}\n`);
    }
  }

  // ── 2. 待发送：尝试发邮件，失败则下次 tick 重试 ──────────────────────────
  if (!s.pending) return;

  const retryNote = s.retries > 0 ? ` (retry ${s.retries}/${NOTIFY_MAX_RETRIES})` : '';
  try {
    if (!dryRun) {
      const body =
        '<p>API 限流已解除，Agently Mail Client 现在运行正常，可以正常收发邮件了。</p>' +
        `<p style="color:#888;font-size:12px;">检测时间：${s.pendingAt}${retryNote}</p>`;
      await mail.send(
        notifyTo,
        'Agently Mail Client 已恢复正常',
        body,
        { bodyFormat: 'html' },
      );
    }
    process.stderr.write(`${tag} Notification sent to ${notifyTo}${retryNote}.\n`);
    // 发送成功：清除待发送，重置偏移到当前末尾，继续监听下一次解除事件。
    s.pending = false;
    s.pendingAt = null;
    s.retries = 0;
    try { s.offset = fs.statSync(logFile).size; } catch { /* best-effort */ }
  } catch (err) {
    s.retries += 1;
    process.stderr.write(
      `${tag} send failed, will retry next tick (${s.retries}/${NOTIFY_MAX_RETRIES}): ${err.message}\n`,
    );
    if (s.retries >= NOTIFY_MAX_RETRIES) {
      process.stderr.write(
        `${tag} giving up after ${s.retries} retries — notification for ${s.pendingAt} dropped.\n`,
      );
      // 放弃这一轮：清除 pending，重置偏移，继续监听下一次解除。
      s.pending = false;
      s.pendingAt = null;
      s.retries = 0;
      try { s.offset = fs.statSync(logFile).size; } catch { /* best-effort */ }
    }
  }
}

module.exports = {
  'rate-limit-recovery': rateLimitRecovery,
};
