'use strict';
/**
 * ScheduleRunner — 定时任务调度器
 *
 * 支持两种任务类型：
 *  - type: profile  调用 AI Profile 执行，结果以邮件发出
 *  - type: builtin  调用注册的 JS handler 函数，由代码自行决定是否发邮件
 *
 * 与主邮件处理流程完全正交：只依赖 ProfileDispatcher.dispatchRaw() 和
 * AgentlyMailClient.send()，不涉及 poll、pending store、ACL 等任何模块。
 */

const fs = require('fs');
const cron = require('node-cron');
const yaml = require('js-yaml');
const { convertMarkdownToHtml } = require('./dispatcher');

function loadSchedulesConfig(configPath) {
  if (!fs.existsSync(configPath)) return { tasks: [] };
  let raw;
  try {
    raw = yaml.load(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return { tasks: [] };
  }
  const tasks = Array.isArray(raw?.tasks) ? raw.tasks : [];
  return { tasks };
}

class ScheduleRunner {
  /**
   * @param {object} opts
   * @param {string}  opts.configPath
   * @param {import('./dispatcher').ProfileDispatcher} opts.dispatcher
   * @param {import('./agently-mail').AgentlyMailClient} opts.mailClient
   * @param {object}  [opts.builtinHandlers]  Map of handler name → async function(task, ctx)
   * @param {boolean} [opts.dryRun=false]
   */
  constructor({ configPath, dispatcher, mailClient, builtinHandlers = {}, dryRun = false }) {
    this._configPath = configPath;
    this._dispatcher = dispatcher;
    this._mail = mailClient;
    this._handlers = builtinHandlers;
    this._dryRun = dryRun;
    this._jobs = [];
  }

  start() {
    this.stop();

    const { tasks } = loadSchedulesConfig(this._configPath);
    if (tasks.length === 0) {
      process.stderr.write('[schedule] No tasks configured (email-schedules.yaml missing or empty).\n');
      return;
    }

    for (const task of tasks) {
      if (task.enabled === false) continue;

      const { name, cron: expr } = task;
      const type = task.type || 'profile';

      if (!name || !expr) {
        process.stderr.write(`[schedule] Task skipped — missing name or cron: ${JSON.stringify(task)}\n`);
        continue;
      }

      if (!cron.validate(expr)) {
        process.stderr.write(`[schedule] Task "${name}" skipped — invalid cron expression: "${expr}"\n`);
        continue;
      }

      if (type === 'builtin') {
        if (!this._handlers[task.handler]) {
          process.stderr.write(`[schedule] Task "${name}" skipped — builtin handler "${task.handler}" not registered\n`);
          continue;
        }
        const job = cron.schedule(expr, () => this._runBuiltin(task), { timezone: task.timezone });
        this._jobs.push(job);
        process.stderr.write(`[schedule] Registered builtin task "${name}" (${expr}) → handler=${task.handler}\n`);
      } else {
        // type: profile (default)
        const { profile, message, to, subject } = task;
        if (!profile || !message || !to || !subject) {
          process.stderr.write(`[schedule] Task "${name}" skipped — missing profile/message/to/subject\n`);
          continue;
        }
        const job = cron.schedule(expr, () => this._runProfile(task), { timezone: task.timezone });
        this._jobs.push(job);
        process.stderr.write(`[schedule] Registered profile task "${name}" (${expr}) → profile=${profile}\n`);
      }
    }
  }

  stop() {
    for (const job of this._jobs) job.stop();
    this._jobs = [];
  }

  /** @private */
  async _runBuiltin(task) {
    const { name, handler } = task;
    process.stderr.write(`[schedule] Running builtin task "${name}" → handler=${handler}\n`);
    const ctx = { mail: this._mail, dryRun: this._dryRun };
    try {
      await this._handlers[handler](task, ctx);
    } catch (err) {
      process.stderr.write(`[schedule] Builtin task "${name}" failed: ${err.message}\n`);
    }
  }

  /** @private */
  async _runProfile(task) {
    const { name, profile, message, to, subject } = task;
    const sessionId = `schedule_${String(name).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    process.stderr.write(`[schedule] Running profile task "${name}" → profile=${profile}\n`);

    let response;
    try {
      ({ response } = await this._dispatcher.dispatchRaw(profile, message, sessionId, this._dryRun));
    } catch (err) {
      process.stderr.write(`[schedule] Task "${name}" dispatch failed: ${err.message}\n`);
      return;
    }

    if (this._dryRun) {
      process.stderr.write(`[schedule] [DRY_RUN] Task "${name}" would send to ${to}: ${response.slice(0, 120)}\n`);
      return;
    }

    try {
      const htmlBody = convertMarkdownToHtml(response);
      await this._mail.send(to, subject, htmlBody, { bodyFormat: 'html' });
      process.stderr.write(`[schedule] Task "${name}" email sent to ${to}\n`);
    } catch (err) {
      process.stderr.write(`[schedule] Task "${name}" send failed: ${err.message}\n`);
    }
  }
}

module.exports = { ScheduleRunner, loadSchedulesConfig };
