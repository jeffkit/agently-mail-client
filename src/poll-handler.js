'use strict';
/**
 * poll-handler.js — 邮件 poll 回调工厂
 *
 * 提供 createPollHandler(deps) 工厂函数，返回供 AgentlyMailClient.poll() 使用的
 * 异步回调。每次 poll 发现新邮件时，bridge 会对每封邮件调用此回调。
 *
 * 职责：
 *  - 过滤自发邮件
 *  - ACL 检查（黑名单 / 白名单 / 开放访问）
 *  - Admin 命令识别与分发
 *  - 批处理模式下进队列 or 即时回复
 *  - 调用 dispatchAndReply 执行 Profile 处理
 */

const { matchesAny } = require('./sender-acl');

/**
 * 提取纯文本正文（用于 admin 指令解析）。
 * @param {object} fullMsg
 * @returns {string}
 */
function _plainBody(fullMsg) {
  const { cleanBody } = require('./dispatcher');
  try { return cleanBody(fullMsg, { stripQuotes: true }); } catch { return ''; }
}

/**
 * @param {object} deps
 * @param {import('./acl-config').AclConfig}          deps.aclCfg
 * @param {import('./sender-acl').SenderAcl}          deps.acl
 * @param {import('./admin-handler').AdminHandler}    deps.admin
 * @param {import('./batch-handler').BatchHandler|null} deps.batchHandler
 * @param {import('./pending-store').PendingStore}    deps.pending
 * @param {Function} deps.dispatchAndReply
 * @param {Function} deps.handleDenied
 * @param {Function} deps.readAndArchive
 * @param {boolean}  deps.filterSelfSent
 * @param {Function} deps.getOwnAddresses   () => Set<string>
 * @param {Function} deps.log               (tid: string, msg: string) => void
 * @param {Function} deps.traceId           () => string
 * @returns {(msg: object, client: object) => Promise<void>}
 */
function createPollHandler(deps) {
  const {
    aclCfg, acl, admin, batchHandler,
    pending, dispatchAndReply, handleDenied, readAndArchive,
    filterSelfSent, getOwnAddresses,
    log, traceId,
  } = deps;

  return async function pollCallback(msg, client) {
    const { message_id, subject, from } = msg;
    const senderEmail = from?.email || '';
    const tid = traceId();

    try {
      // Skip emails we sent ourselves (prevents reply loops)
      if (filterSelfSent) {
        const ownAddresses = getOwnAddresses();
        const senderNorm = senderEmail.toLowerCase();
        if (ownAddresses.has(senderNorm)) {
          log(tid, `Skipping self-sent: "${subject}" (${message_id})`);
          return;
        }
      }

      // Admin path: read message, check for commands, bypass normal ACL + dispatch
      if (acl.isAdmin(senderEmail)) {
        log(tid, `Admin message from ${senderEmail}: "${subject}"`);
        let fullMsg;
        try {
          fullMsg = await readAndArchive(client, message_id);
        } catch (err) {
          log(tid, `Admin message read failed: ${err.message} — will retry on next sweep`);
          pending.add(msg);
          pending.markFailed(message_id, `admin read failed: ${err.message}`);
          return;
        }
        const body = fullMsg ? _plainBody(fullMsg) : '';

        // Batch mode: admin replies to a summary email → BatchHandler interprets and executes
        if (batchHandler && batchHandler.isBatchReply(subject)) {
          log(tid, `Batch owner reply from ${senderEmail}: "${subject}"`);
          await batchHandler.handleOwnerReply(message_id, fullMsg, senderEmail);
          return;
        }

        if (admin.hasCommands(body)) {
          await admin.executeCommands(message_id, body, senderEmail);
          return;
        }
        // Admin with no commands → fall through to normal dispatch
      }

      // ── ACL + 分流（非 admin 发件人）────────────────────────────────────────
      // 批处理模式：黑名单 → 拒；白名单(allowed_senders) ∪ 即时名单(instant_reply_senders)
      //   → 即时回复；其余（非白名单非黑名单）→ 进批队列待主人决策。
      // 非批处理模式：黑名单 / 白名单外 → 拒；白名单内（或开放访问）→ 即时回复。
      if (!acl.isAdmin(senderEmail)) {
        const isBlacklisted = matchesAny(senderEmail, aclCfg.deniedSenders);
        if (isBlacklisted) {
          await handleDenied(client, msg, 'blacklisted');
          return;
        }

        const isOpen = aclCfg.allowedSenders.length === 0;
        const inWhitelist = !isOpen && matchesAny(senderEmail, aclCfg.allowedSenders);
        const isInstant = inWhitelist || matchesAny(senderEmail, aclCfg.instantReplySenders);

        if (batchHandler) {
          if (!isInstant) {
            // 进批队列待主人决策（read() 在服务端标记已读，先 add 防丢失）
            pending.add(msg);
            let fullMsg;
            try {
              fullMsg = await readAndArchive(client, message_id);
            } catch (err) {
              log(tid, `Batch read failed for ${message_id}: ${err.message}`);
              pending.markFailed(message_id, `read failed: ${err.message}`);
              return;
            }
            batchHandler.enqueue(msg, fullMsg);
            pending.markReplied(message_id);
            log(tid, `[BATCH] Queued (not dispatched): "${subject}" from ${senderEmail}`);
            return;
          }
          // 白名单 / 即时名单 → fall through 到即时处理
        } else if (!isOpen && !inWhitelist) {
          await handleDenied(client, msg, 'global ACL');
          return;
        }
      }

      // 即时处理路径（admin / 白名单 / 即时名单 / 开放访问）
      pending.add(msg);
      await dispatchAndReply(message_id, subject, senderEmail, client, false);
    } catch (err) {
      log(tid, `Unhandled error in poll handler for ${message_id}: ${err.message}`);
    }
  };
}

module.exports = { createPollHandler };
