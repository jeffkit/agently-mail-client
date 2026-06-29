'use strict';
/**
 * dispatch-core.js — 核心 dispatch 逻辑工厂
 *
 * 提供 createDispatcher(deps) 工厂函数，返回 dispatchAndReply 和 handleDenied。
 * 两者被 poll-handler 和 retry-sweep 共同使用。
 *
 * 与 index.js 解耦：不直接引用任何 "全局" 状态，全部通过 deps 注入。
 */

const { matchesAny } = require('./sender-acl');
const { convertMarkdownToHtml } = require('./dispatcher');
const { computeThreadRoot } = require('./mail-archive');

/**
 * 创建 dispatch 核心（dispatchAndReply + handleDenied）。
 *
 * @param {object} deps
 * @param {import('./agently-mail').AgentlyMailClient} deps.mail
 * @param {import('./dispatcher').ProfileDispatcher}  deps.dispatcher
 * @param {import('./pending-store').PendingStore}    deps.pending
 * @param {import('./mail-archive').MailArchive}      deps.archive
 * @param {import('./sender-acl').SenderAcl}          deps.acl
 * @param {import('./acl-config').AclConfig}          deps.aclCfg
 * @param {import('./denied-log').DeniedLog}          deps.deniedLog
 * @param {boolean}  deps.dryRun
 * @returns {{ dispatchAndReply: Function, handleDenied: Function, log: Function, traceId: Function }}
 */
function createDispatcher(deps) {
  const { mail, dispatcher, pending, archive, acl, aclCfg, deniedLog, dryRun } = deps;

  const processingSet = new Set();

  function traceId() {
    return Math.random().toString(16).slice(2, 8);
  }

  function log(tid, msg) {
    process.stderr.write(`[email-bridge]${tid ? ` [${tid}]` : ''} ${msg}\n`);
  }

  /**
   * 读取邮件并归档正文（incoming）。best-effort：归档失败只记日志，不影响主流程。
   * @param {import('./agently-mail').AgentlyMailClient} client
   * @param {string} messageId
   * @returns {Promise<object>} fullMsg
   */
  async function readAndArchive(client, messageId) {
    const fullMsg = await client.read(messageId);
    try { archive.archiveIncoming(fullMsg); } catch (err) {
      process.stderr.write(`[email-bridge] archiveIncoming failed for ${messageId}: ${err.message}\n`);
    }
    return fullMsg;
  }

  /**
   * 回复邮件并归档发出内容（outgoing）。
   * @param {import('./agently-mail').AgentlyMailClient} client
   * @param {string} messageId
   * @param {string} body
   * @param {object} opts
   * @param {object} fullMsg
   */
  async function replyAndArchive(client, messageId, body, opts, fullMsg) {
    const res = await client.reply(messageId, body, opts);
    try {
      archive.archiveOutgoing({
        thread_root: computeThreadRoot(fullMsg),
        in_reply_to: fullMsg?.rfc_message_id || fullMsg?.message_id || null,
        to: fullMsg?.from ? [fullMsg.from] : null,
        cc: opts?.cc || null,
        subject: fullMsg?.subject || '',
        body_html: opts?.bodyFormat === 'html' ? body : null,
        body_text: opts?.bodyFormat === 'html' ? null : body,
        references: fullMsg?.references || null,
        source: 'bridge',
      });
    } catch (err) {
      process.stderr.write(`[email-bridge] archiveOutgoing failed for ${messageId}: ${err.message}\n`);
    }
    return res;
  }

  /**
   * Handle a sender that failed ACL checks: log it, record in denied log,
   * mark the pending entry as done, and optionally notify the sender.
   *
   * @param {import('./agently-mail').AgentlyMailClient} client
   * @param {object} msg    message summary (message_id, subject, from)
   * @param {string} reason denial reason string
   */
  async function handleDenied(client, msg, reason) {
    const { message_id, subject, from } = msg;
    process.stderr.write(
      `[email-bridge] ACL denied: "${subject}" from ${from?.email} — ${reason}\n`,
    );

    deniedLog.record(msg, reason);

    // Mark as done in pending store to prevent retry sweep re-processing
    pending.add(msg);
    pending.markReplied(message_id);

    // Archive the denied mail so it appears in the dashboard inbox view
    try {
      await readAndArchive(client, message_id);
    } catch (err) {
      process.stderr.write(
        `[email-bridge] archive denied message failed for ${message_id}: ${err.message}\n`,
      );
    }

    if (acl.denyAction === 'notify' && !dryRun) {
      const body = aclCfg.denyMessage ||
        '感谢您的来信。您的邮件无法被自动处理，请联系管理员。\n\nThank you for your message. Your email could not be processed automatically. Please contact the administrator.';
      try {
        await client.reply(message_id, body, { bodyFormat: 'plain' });
        process.stderr.write(`[email-bridge] ACL deny notification sent: ${message_id}\n`);
      } catch (err) {
        process.stderr.write(`[email-bridge] ACL notify reply failed: ${err.message}\n`);
      }
    }
  }

  /**
   * Core dispatch-and-reply logic shared between new mail handler and retry sweep.
   * Returns true on success, false on failure.
   *
   * @param {string}  message_id
   * @param {string}  subject
   * @param {string}  fromEmail
   * @param {import('./agently-mail').AgentlyMailClient} client
   * @param {boolean} [isRetry=false]
   * @returns {Promise<boolean>}
   */
  async function dispatchAndReply(message_id, subject, fromEmail, client, isRetry = false) {
    if (processingSet.has(message_id)) {
      log('', `Skipping duplicate dispatch for ${message_id} (already in progress)`);
      return true;
    }
    processingSet.add(message_id);
    const tid = traceId();
    try {
      const tag = isRetry ? '[RETRY]' : '';
      log(tid, `${tag} Processing: "${subject}" from ${fromEmail} (${message_id})`);

      let fullMsg;
      try {
        fullMsg = await readAndArchive(client, message_id);
      } catch (err) {
        log(tid, `${tag} Failed to read ${message_id}: ${err.message}`);
        pending.markFailed(message_id, `read failed: ${err.message}`);
        return false;
      }

      // Resolve profile first so we can run per-profile ACL check
      let resolvedProfile;
      try {
        resolvedProfile = dispatcher.resolveProfile(fullMsg.subject || '');
      } catch (err) {
        log(tid, `${tag} Profile resolution failed: ${err.message}`);
        pending.markFailed(message_id, `profile resolve failed: ${err.message}`);
        return false;
      }

      // Per-profile ACL check (global ACL already passed in poll handler)
      if (acl.checkProfile(resolvedProfile.profileName, fromEmail) === 'deny') {
        log(tid, `${tag} ACL denied profile "${resolvedProfile.profileName}" for ${fromEmail}`);
        const msgSummary = { message_id, subject, from: { email: fromEmail } };
        await handleDenied(client, msgSummary, `profile "${resolvedProfile.profileName}" not allowed`);
        return true;
      }

      let response, profileName;
      try {
        ({ response, profileName } = await dispatcher.dispatch(fullMsg, dryRun));
      } catch (err) {
        const failedAt = new Date().toISOString();
        log(tid, `${tag} Dispatch failed for ${message_id} (profile=${resolvedProfile.profileName}) at ${failedAt}: ${err.message}`);
        pending.markFailed(message_id, `dispatch failed: ${err.message}`);
        return false;
      }

      log(tid, `${tag} Profile: ${profileName} → ${response.length} chars`);

      if (!dryRun) {
        try {
          const htmlResponse = convertMarkdownToHtml(response);
          await replyAndArchive(client, message_id, htmlResponse, { bodyFormat: 'html' }, fullMsg);
          pending.markReplied(message_id);
          log(tid, `${tag} Replied (HTML): ${message_id}`);
        } catch (err) {
          log(tid, `${tag} Reply failed for ${message_id}: ${err.message}`);
          pending.markFailed(message_id, `reply failed: ${err.message}`);
          return false;
        }
      } else {
        pending.markReplied(message_id);
        log(tid, `${tag} [DRY_RUN] Would reply: ${response.slice(0, 120)}`);
      }
      return true;
    } finally {
      processingSet.delete(message_id);
    }
  }

  return { dispatchAndReply, handleDenied, readAndArchive, log, traceId };
}

module.exports = { createDispatcher };
