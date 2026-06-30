'use strict';
/**
 * Tests for the rateLimitRecovery builtin handler (hardened version).
 *
 * 覆盖：首次运行只记录偏移；扫到信号→发送；发送失败→下次 tick 重试；
 *      发送成功→清除 pending 并重置偏移（每次解除都通知）；日志截断自愈。
 *
 * Run: node --test tests/test-rate-limit-recovery.js
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const handlers = require('../src/builtin-handlers');
const h = handlers['rate-limit-recovery'];

function setup() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlr-'));
  const logFile = path.join(tmpDir, 'bridge.log');
  fs.writeFileSync(logFile, 'initial bridge log\n');
  const task = { name: `test-rlr-${Date.now()}`, log_file: logFile, notify_to: 'me@example.com' };
  const sent = [];
  const mail = {
    async send(to, subject, body, opts) {
      if (mail._fail) throw new Error('simulated 429');
      sent.push({ to, subject });
    },
    _fail: false,
  };
  const ctx = { mail, dryRun: false };
  const writeLog = (s) => fs.appendFileSync(logFile, s + '\n');
  return { task, sent, mail, ctx, writeLog, logFile };
}

test('首次运行只记录偏移，不发送', async () => {
  const { task, sent, ctx } = setup();
  await h(task, ctx);
  assert.strictEqual(sent.length, 0);
});

test('扫到 "Rate limit cleared" 信号后发送通知', async () => {
  const { task, sent, ctx, writeLog } = setup();
  await h(task, ctx);                                   // 记录偏移
  writeLog('[agently-mail] Next poll in 900s (idle)');  // 无关行
  await h(task, ctx);
  assert.strictEqual(sent.length, 0);
  writeLog('[agently-mail] Rate limit cleared, resuming adaptive interval.');
  await h(task, ctx);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].to, 'me@example.com');
});

test('每次限流解除都通知（不会发一次就自禁用）', async () => {
  const { task, sent, ctx, writeLog } = setup();
  await h(task, ctx);
  writeLog('[agently-mail] Rate limit cleared, resuming adaptive interval.');
  await h(task, ctx);
  writeLog('[agently-mail] Rate limit cleared, resuming adaptive interval.');
  await h(task, ctx);
  assert.strictEqual(sent.length, 2);
});

test('发送失败保留 pending，下次 tick 重试至成功', async () => {
  const { task, sent, mail, ctx, writeLog } = setup();
  await h(task, ctx);
  writeLog('[agently-mail] Rate limit cleared, resuming adaptive interval.');
  mail._fail = true;
  await h(task, ctx);          // 检测到信号 + 发送失败
  assert.strictEqual(sent.length, 0, '发送失败不应记为成功');
  await h(task, ctx);          // 重试仍失败
  assert.strictEqual(sent.length, 0, '重试失败应保留 pending');
  mail._fail = false;
  await h(task, ctx);          // 重试成功
  assert.strictEqual(sent.length, 1, '重试成功应发出通知');
});

test('日志截断后仍能检测新信号（偏移自愈）', async () => {
  const { task, sent, ctx, writeLog, logFile } = setup();
  await h(task, ctx);
  writeLog('[agently-mail] Rate limit cleared, resuming adaptive interval.');
  await h(task, ctx);                                   // 发送一次，sent=1
  // 模拟 /tmp 被清：文件被覆写为短内容，再追加新信号
  fs.writeFileSync(logFile, 'truncated\n');
  writeLog('[agently-mail] Rate limit cleared, resuming adaptive interval.');
  await h(task, ctx);
  assert.strictEqual(sent.length, 2, '截断后应能检测新信号并发送');
});
