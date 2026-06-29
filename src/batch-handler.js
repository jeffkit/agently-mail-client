'use strict';
/**
 * BatchHandler — 批处理模式的核心：摘要生成 + 主人指令解读 + 执行调度
 *
 * 职责：
 *   1. 定期（batchIntervalMs）构建摘要邮件发给 admin_senders
 *      摘要分两栏：「已自动处理」+ 「待您决策」
 *   2. 识别主人对摘要邮件的回复，用 AI 解读自然语言指令
 *      → 对每封待处理邮件决定 reply / skip
 *   3. 执行决策：reply 走正常 dispatchAndReply 流程，skip 标记跳过
 *
 * AI 解读提示词设计：
 *   - 输入：主人的自然语言指令 + 待处理邮件列表（编号、发件人、主题、摘要）
 *   - 输出：JSON 数组，格式 [{ "message_id": "...", "action": "reply"|"skip" }, ...]
 *   - Profile：使用 email-acl.yaml batch_mode.ai_profile 指定的 profile，
 *             缺省使用 email-profiles.yaml 的 default profile
 */

const { cleanBody, convertMarkdownToHtml } = require('./dispatcher');

// 摘要邮件主题前缀，用于识别主人的回复（AdminHandler 已通过 isAdmin 鉴权）
const BATCH_SUMMARY_SUBJECT_PREFIX = '[邮件批处理摘要]';

// AI 解读输出的最大长度保护（防止 profile 输出乱码导致 JSON.parse 无限等待）
const MAX_AI_OUTPUT_LENGTH = 8000;

// 正文摘要截取长度
const SNIPPET_LENGTH = 120;

class BatchHandler {
  /**
   * @param {object} opts
   * @param {import('./batch-store').BatchStore}       opts.batchStore
   * @param {import('./acl-config').AclConfig}         opts.aclConfig
   * @param {import('./agently-mail').AgentlyMailClient} opts.mailClient
   * @param {import('./dispatcher').ProfileDispatcher} opts.dispatcher
   * @param {Function}  opts.dispatchAndReply   来自 index.js 的核心执行函数
   * @param {object}    opts.batchConfig        来自 email-acl.yaml 的 batch_mode 段
   * @param {boolean}   [opts.dryRun]
   */
  constructor(opts) {
    this._store          = opts.batchStore;
    this._acl            = opts.aclConfig;
    this._mail           = opts.mailClient;
    this._dispatcher     = opts.dispatcher;
    this._dispatchAndReply = opts.dispatchAndReply;
    this._cfg            = opts.batchConfig || {};
    this._dryRun         = opts.dryRun || false;
    this._timer          = null;
    this._summarySending = false; // mutex: prevent overlapping _sendSummary calls
    // 上次发送摘要的时间从 BatchStore 加载（重启后不失忆）
    this._lastReportAt   = this._store.getLastReportAt();
  }

  // ── 公开 API ───────────────────────────────────────────────────────────────

  /**
   * 启动批处理摘要定时器。
   * @param {number} batchIntervalMs
   */
  start(batchIntervalMs) {
    if (this._timer) return;
    this._timer = setInterval(() => this._sendSummary(), batchIntervalMs);
    process.stderr.write(
      `[batch] Batch mode started (interval=${Math.round(batchIntervalMs / 60000)}min)\n`,
    );
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * 将一封通过 ACL 的邮件加入批队列（poll handler 调用）。
   * 同时截取正文片段用于摘要预览。
   *
   * @param {object} msgSummary  poll 返回的邮件摘要
   * @param {object} [fullMsg]   已读取的完整消息（可选，用于提取 snippet）
   */
  enqueue(msgSummary, fullMsg) {
    let snippet = '';
    if (fullMsg) {
      try {
        const body = cleanBody(fullMsg, { stripQuotes: false, maxLength: SNIPPET_LENGTH * 3 });
        snippet = body.slice(0, SNIPPET_LENGTH).replace(/\n+/g, ' ').trim();
        if (body.length > SNIPPET_LENGTH) snippet += '…';
      } catch {
        snippet = '';
      }
    }
    this._store.enqueue(msgSummary, snippet);
    process.stderr.write(
      `[batch] Queued: "${msgSummary.subject}" from ${msgSummary.from?.email}\n`,
    );
  }

  /**
   * 判断一封邮件是否是对批处理摘要的回复（主人的决策指令）。
   * 检查主题是否以 "Re: [邮件批处理摘要]" 开头。
   *
   * @param {string} subject
   * @returns {boolean}
   */
  isBatchReply(subject) {
    return /^re:\s*\[邮件批处理摘要\]/i.test(subject || '');
  }

  /**
   * 处理主人对摘要邮件的回复：AI 解读指令 → 执行 reply/skip。
   *
   * @param {string} messageId   主人的回复邮件 ID（用于回复执行结果）
   * @param {object} fullMsg     完整邮件对象
   * @param {string} fromEmail   主人邮箱
   */
  async handleOwnerReply(messageId, fullMsg, fromEmail) {
    const body = cleanBody(fullMsg, { stripQuotes: true, maxLength: 2000 });
    const queued = this._store.getQueued();

    if (queued.length === 0) {
      process.stderr.write(`[batch] Owner replied to summary but no queued messages found\n`);
      if (!this._dryRun) {
        try {
          await this._mail.reply(messageId, '当前没有待处理的邮件。', { bodyFormat: 'plain' });
        } catch (err) {
          process.stderr.write(`[batch] Reply failed: ${err.message}\n`);
        }
      }
      return;
    }

    process.stderr.write(
      `[batch] Owner reply received from ${fromEmail}, interpreting instructions for ${queued.length} queued mail(s)\n`,
    );

    // AI 解读主人指令
    let decisions;
    try {
      decisions = await this._interpretInstructions(body, queued);
    } catch (err) {
      process.stderr.write(`[batch] AI interpretation failed: ${err.message}\n`);
      if (!this._dryRun) {
        try {
          await this._mail.reply(
            messageId,
            `指令解读失败：${err.message}\n\n请重新发送指令。`,
            { bodyFormat: 'plain' },
          );
        } catch (replyErr) {
          process.stderr.write(`[batch] Error reply failed: ${replyErr.message}\n`);
        }
      }
      return;
    }

    // 执行决策
    const results = await this._executeDecisions(decisions, queued);

    // 回复执行摘要给主人
    const summary = this._buildExecutionSummary(results);
    process.stderr.write(`[batch] Execution done. ${results.length} decision(s) applied.\n`);

    if (!this._dryRun) {
      try {
        const html = convertMarkdownToHtml(summary);
        await this._mail.reply(messageId, html, { bodyFormat: 'html' });
      } catch (err) {
        process.stderr.write(`[batch] Execution summary reply failed: ${err.message}\n`);
      }
    } else {
      process.stderr.write(`[batch][DRY_RUN] Execution summary:\n${summary}\n`);
    }
  }

  // ── 私有：定时摘要 ─────────────────────────────────────────────────────────

  async _sendSummary() {
    if (this._summarySending) {
      process.stderr.write(`[batch] Previous summary still sending, skipping this tick\n`);
      return;
    }
    this._summarySending = true;
    try {
      await this._doSendSummary();
    } finally {
      this._summarySending = false;
    }
  }

  async _doSendSummary() {
    const admins = this._acl.adminSenders;
    if (admins.length === 0) {
      process.stderr.write(`[batch] No admin_senders configured, skipping summary\n`);
      return;
    }

    const since = this._lastReportAt;
    const queued = this._store.getQueued();

    // 已自动处理的邮件（上次报告之后）— 来自 PendingStore 的已回复/ACL拦截记录
    // 这里通过 BatchStore 的全量记录拿到非 queued 的条目
    const processed = this._store.getAll({ since: since || undefined }).filter(
      (e) => e.status !== 'queued',
    );

    // 没有任何需要汇报的内容时跳过
    if (queued.length === 0 && processed.length === 0) {
      process.stderr.write(`[batch] Nothing to report, skipping summary\n`);
      return;
    }

    const subject = `${BATCH_SUMMARY_SUBJECT_PREFIX} ${_formatTime(new Date())}`;
    const body    = this._buildSummaryBody(processed, queued);
    const now     = new Date().toISOString();

    process.stderr.write(
      `[batch] Sending summary: ${queued.length} queued, ${processed.length} processed → ${admins.join(', ')}\n`,
    );

    if (this._dryRun) {
      process.stderr.write(`[batch][DRY_RUN] Summary subject: ${subject}\n${body}\n`);
      this._lastReportAt = now;
      this._store.setLastReportAt(now);
      return;
    }

    for (const adminEmail of admins) {
      try {
        const html = convertMarkdownToHtml(body);
        await this._mail.send(adminEmail, subject, html, { bodyFormat: 'html' });
        process.stderr.write(`[batch] Summary sent to ${adminEmail}\n`);
      } catch (err) {
        process.stderr.write(`[batch] Summary send failed (${adminEmail}): ${err.message}\n`);
      }
    }

    this._lastReportAt = now;
    this._store.setLastReportAt(now);
    this._store.cleanup();
  }

  // ── 私有：AI 指令解读 ──────────────────────────────────────────────────────

  /**
   * 用 AI profile 解读主人的自然语言指令，返回决策数组。
   *
   * @param {string}   ownerInstruction  主人指令原文
   * @param {object[]} queued            待处理邮件列表
   * @returns {Promise<Array<{message_id: string, action: 'reply'|'skip'}>>}
   */
  async _interpretInstructions(ownerInstruction, queued) {
    const mailList = queued.map((e, i) =>
      `[${i + 1}] message_id=${e.message_id}\n` +
      `    发件人: ${e.from_name ? `${e.from_name} <${e.from_email}>` : e.from_email}\n` +
      `    主题: ${e.subject}\n` +
      `    摘要: ${e.body_snippet || '（无预览）'}`,
    ).join('\n\n');

    const prompt = [
      '你是一个邮件处理助手。主人对以下待处理邮件给出了处理指令，请将指令解析为每封邮件的具体操作。',
      '',
      '待处理邮件列表：',
      mailList,
      '',
      '主人的指令：',
      ownerInstruction,
      '',
      '请严格按以下 JSON 格式输出决策，不要输出任何其他内容：',
      '[',
      '  {"message_id": "msg_xxx", "action": "reply"},',
      '  {"message_id": "msg_yyy", "action": "skip"}',
      ']',
      '',
      '其中 action 只能是 "reply"（让 AI 回复这封邮件）或 "skip"（跳过不处理）。',
      '必须为每封邮件给出决策，不能遗漏。',
      '如果主人的指令涵盖所有邮件（如"全部回复"），则对所有邮件都设为 reply。',
    ].join('\n');

    // 调用 dispatcher 的默认 profile 来解读
    const profileName = this._cfg.ai_profile || this._dispatcher.config.default;
    const profileConfig = this._dispatcher.config.profiles[profileName];
    if (!profileConfig) {
      throw new Error(`Batch AI profile "${profileName}" not found in profiles config`);
    }

    // 构造一个最小化的 fullMsg 对象来复用 dispatcher._spawnProfile
    const rawOutput = await this._dispatcher._spawnProfile(
      profileConfig,
      prompt,
      '',           // 无会话历史，每次解读独立
      'batch-interpret',
      'batch',
      this._dryRun,
      profileName,
      'batch-interpret',
    );

    const text = (rawOutput.response || '').slice(0, MAX_AI_OUTPUT_LENGTH);

    // 从输出中提取 JSON 数组（AI 可能在 JSON 前后输出多余文字）
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error(`AI output did not contain a JSON array. Got: ${text.slice(0, 200)}`);
    }

    let decisions;
    try {
      decisions = JSON.parse(jsonMatch[0]);
    } catch (err) {
      throw new Error(`AI output JSON parse failed: ${err.message}. Raw: ${jsonMatch[0].slice(0, 200)}`);
    }

    if (!Array.isArray(decisions)) {
      throw new Error(`AI output is not an array`);
    }

    // 校验并补全（AI 可能遗漏某些条目，默认 skip）
    const knownIds = new Set(queued.map((e) => e.message_id));
    const decisionMap = new Map();
    for (const d of decisions) {
      if (d && typeof d.message_id === 'string' && knownIds.has(d.message_id)) {
        const action = d.action === 'reply' ? 'reply' : 'skip';
        decisionMap.set(d.message_id, action);
      }
    }
    // 补全遗漏的条目
    for (const e of queued) {
      if (!decisionMap.has(e.message_id)) {
        decisionMap.set(e.message_id, 'skip');
      }
    }

    return Array.from(decisionMap.entries()).map(([message_id, action]) => ({ message_id, action }));
  }

  // ── 私有：执行决策 ─────────────────────────────────────────────────────────

  /**
   * @param {Array<{message_id: string, action: string}>} decisions
   * @param {object[]} queued
   * @returns {Promise<Array<{entry: object, action: string, success: boolean, error?: string}>>}
   */
  async _executeDecisions(decisions, queued) {
    const queuedMap = new Map(queued.map((e) => [e.message_id, e]));
    const results = [];

    for (const { message_id, action } of decisions) {
      const entry = queuedMap.get(message_id);
      if (!entry) continue;

      if (action === 'skip') {
        this._store.markSkipped(message_id);
        results.push({ entry, action: 'skip', success: true });
        process.stderr.write(`[batch] Skipped: ${message_id} "${entry.subject}"\n`);
        continue;
      }

      // action === 'reply'：走正常 dispatchAndReply 流程
      process.stderr.write(`[batch] Dispatching: ${message_id} "${entry.subject}"\n`);
      try {
        const ok = await this._dispatchAndReply(
          message_id,
          entry.subject,
          entry.from_email,
          this._mail,
          false,
        );
        if (ok) {
          this._store.markReplied(message_id);
          results.push({ entry, action: 'reply', success: true });
        } else {
          this._store.markFailed(message_id, 'dispatch returned false');
          results.push({ entry, action: 'reply', success: false, error: 'dispatch failed' });
        }
      } catch (err) {
        this._store.markFailed(message_id, err.message);
        results.push({ entry, action: 'reply', success: false, error: err.message });
      }
    }

    return results;
  }

  // ── 私有：构建邮件正文 ─────────────────────────────────────────────────────

  _buildSummaryBody(processed, queued) {
    const lines = [
      `## 📬 邮件处理摘要`,
      `生成时间：${_formatTime(new Date())}`,
      '',
    ];

    // 已自动处理部分
    if (processed.length > 0) {
      lines.push(`### ✅ 已自动处理（${processed.length} 封）`);
      lines.push('');
      for (const e of processed) {
        const sender = e.from_name ? `${e.from_name} <${e.from_email}>` : e.from_email;
        const statusIcon = e.status === 'replied' ? '✅' : e.status === 'skipped' ? '⏭️' : '❌';
        const statusText = e.status === 'replied' ? '已回复' : e.status === 'skipped' ? '已跳过' : `失败：${e.error || ''}`;
        lines.push(`${statusIcon} **${sender}** — "${e.subject}" → ${statusText}`);
      }
      lines.push('');
    }

    // 待决策部分
    if (queued.length > 0) {
      lines.push(`### 🕐 待您决策（${queued.length} 封）`);
      lines.push('');
      queued.forEach((e, i) => {
        const sender = e.from_name ? `${e.from_name} <${e.from_email}>` : e.from_email;
        const ts = _formatTime(new Date(e.created_at));
        lines.push(`**[${i + 1}]** ${sender}`);
        lines.push(`主题：${e.subject}`);
        lines.push(`时间：${ts}`);
        if (e.body_snippet) lines.push(`摘要：${e.body_snippet}`);
        lines.push('');
      });
      lines.push('---');
      lines.push('');
      lines.push('**直接回复本邮件**，用自然语言告诉我如何处理这些邮件即可。');
      lines.push('');
      lines.push('例如：');
      lines.push('- "第1封帮我礼貌回绝，第2封认真回答，其余忽略"');
      lines.push('- "全部回复"');
      lines.push('- "1和3跳过，2回复"');
    } else {
      lines.push('*当前无待决策邮件。*');
    }

    return lines.join('\n');
  }

  _buildExecutionSummary(results) {
    const lines = [`## 📋 执行结果`, ''];
    for (const { entry, action, success, error } of results) {
      const sender = entry.from_name ? `${entry.from_name} <${entry.from_email}>` : entry.from_email;
      if (action === 'skip') {
        lines.push(`⏭️ **已跳过**：${sender} — "${entry.subject}"`);
      } else if (success) {
        lines.push(`✅ **已回复**：${sender} — "${entry.subject}"`);
      } else {
        lines.push(`❌ **回复失败**：${sender} — "${entry.subject}"${error ? `（${error}）` : ''}`);
      }
    }
    return lines.join('\n');
  }
}

// ── 工具函数 ───────────────────────────────────────────────────────────────

function _formatTime(date) {
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

module.exports = { BatchHandler, BATCH_SUMMARY_SUBJECT_PREFIX, SNIPPET_LENGTH };
