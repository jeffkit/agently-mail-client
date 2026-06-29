'use strict';
/**
 * retry-sweep.js — 重试扫描工厂
 *
 * 提供 createRetrySweep(deps) 工厂函数，返回供 setInterval 调用的异步扫描函数。
 *
 * 扫描逻辑：从 PendingStore 读取超过冷却期且未超重试上限的条目，
 * 对每条调用 dispatchAndReply 重试，最后触发 cleanup。
 */

/**
 * @param {object} deps
 * @param {import('./pending-store').PendingStore} deps.pending
 * @param {import('./agently-mail').AgentlyMailClient} deps.mail
 * @param {Function} deps.dispatchAndReply
 * @param {Function} deps.log               (tid: string, msg: string) => void
 * @returns {() => Promise<void>}
 */
function createRetrySweep(deps) {
  const { pending, mail, dispatchAndReply, log } = deps;

  return async function runRetrySweep() {
    try {
      const retryQueue = pending.getPending();
      if (retryQueue.length === 0) {
        pending.cleanup();
        return;
      }
      log('', `Retry sweep: ${retryQueue.length} pending message(s)`);
      for (const entry of retryQueue) {
        try {
          await dispatchAndReply(entry.message_id, entry.subject, entry.from_email, mail, true);
        } catch (err) {
          log('', `Retry sweep dispatch threw for ${entry.message_id}: ${err.message}`);
        }
      }
      pending.cleanup();
    } catch (err) {
      log('', `Retry sweep failed (will retry next tick): ${err.message}`);
    }
  };
}

module.exports = { createRetrySweep };
