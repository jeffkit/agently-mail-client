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

/**
 * 通过读取日志文件判断限流是否解除，解除后发一封通知邮件，然后自行停止。
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

  // Read only content added after the handler was first registered.
  // We track offset via a module-level map keyed by task name.
  if (!rateLimitRecovery._offsets) rateLimitRecovery._offsets = {};
  const offsets = rateLimitRecovery._offsets;

  try {
    if (!(task.name in offsets)) {
      // First run: record current file size so we only watch new lines.
      offsets[task.name] = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
      return;
    }

    const stat = fs.statSync(logFile);
    if (stat.size <= offsets[task.name]) return;

    const fd = fs.openSync(logFile, 'r');
    const buf = Buffer.alloc(stat.size - offsets[task.name]);
    fs.readSync(fd, buf, 0, buf.length, offsets[task.name]);
    fs.closeSync(fd);
    offsets[task.name] = stat.size;

    if (!buf.toString('utf8').includes(SIGNAL)) return;

    // Signal found — rate limit has cleared
    process.stderr.write('[builtin:rate-limit-recovery] Rate limit cleared detected. Sending notification.\n');

    if (!dryRun) {
      await mail.send(
        notifyTo,
        'Agently Mail Client 已恢复正常',
        '<p>API 限流已解除，Agently Mail Client 现在运行正常，可以正常收发邮件了。</p>',
        { bodyFormat: 'html' },
      );
      process.stderr.write(`[builtin:rate-limit-recovery] Notification sent to ${notifyTo}\n`);
    } else {
      process.stderr.write(`[builtin:rate-limit-recovery] [DRY_RUN] Would notify ${notifyTo}\n`);
    }

    // Self-disable: remove offset entry so subsequent runs are no-ops
    // (task stays in yaml until user removes it)
    offsets[task.name] = Infinity;
  } catch (err) {
    process.stderr.write(`[builtin:rate-limit-recovery] Error: ${err.message}\n`);
  }
}

module.exports = {
  'rate-limit-recovery': rateLimitRecovery,
};
