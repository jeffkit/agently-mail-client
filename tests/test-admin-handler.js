'use strict';
/**
 * Tests for AdminHandler — admin 指令执行与巡检报告。
 *
 * Covers: hasCommands / executeCommands (dry-run) / _buildReportBody /
 *         _sendReport (dry-run) / parseCommands
 *
 * Run: node --test tests/test-admin-handler.js
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { AdminHandler, parseCommands } = require('../src/admin-handler');
const { AclConfig }   = require('../src/acl-config');
const { DeniedLog }   = require('../src/denied-log');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'admin-handler-'));
}

/** Minimal mock mail client that records calls. */
function mockMailClient() {
  const calls = { reply: [], send: [] };
  return {
    calls,
    async reply(messageId, body, opts) {
      calls.reply.push({ messageId, body, opts });
    },
    async send(to, subject, body, opts) {
      calls.send.push({ to, subject, body, opts });
    },
  };
}

function makeAcl(dir) {
  return new AclConfig({
    aclConfigFile: null,
    dynamicFile: path.join(dir, 'acl-dynamic.json'),
  });
}

function makeDeniedLog(dir) {
  return new DeniedLog(path.join(dir, 'denied-log.json'));
}

// ---------------------------------------------------------------------------
// parseCommands
// ---------------------------------------------------------------------------

test('parseCommands: parses /allow /deny /reset /status', () => {
  const body = `/allow user@example.com
/deny @evil.com
/reset admin@example.com
/status`;
  const cmds = parseCommands(body);
  assert.equal(cmds.length, 4);
  assert.deepStrictEqual(cmds[0], { cmd: '/allow', arg: 'user@example.com' });
  assert.deepStrictEqual(cmds[1], { cmd: '/deny',  arg: '@evil.com' });
  assert.deepStrictEqual(cmds[2], { cmd: '/reset', arg: 'admin@example.com' });
  assert.deepStrictEqual(cmds[3], { cmd: '/status', arg: '' });
});

test('parseCommands: case-insensitive', () => {
  const cmds = parseCommands('/ALLOW User@Example.COM\n/DENY @EVIL.COM');
  assert.equal(cmds[0].cmd, '/allow');
  assert.equal(cmds[1].cmd, '/deny');
});

test('parseCommands: ignores /allow without argument', () => {
  const cmds = parseCommands('/allow\n/deny\n/reset');
  assert.equal(cmds.length, 0, 'commands without required args should be ignored');
});

test('parseCommands: returns empty array for plain text', () => {
  assert.deepStrictEqual(parseCommands('Hello! Please process my request.'), []);
});

// ---------------------------------------------------------------------------
// hasCommands()
// ---------------------------------------------------------------------------

test('hasCommands: true when commands present', () => {
  const dir = tmpDir();
  const handler = new AdminHandler(makeAcl(dir), makeDeniedLog(dir), mockMailClient(), { dryRun: true });
  assert.equal(handler.hasCommands('/allow user@example.com'), true);
});

test('hasCommands: false for plain text', () => {
  const dir = tmpDir();
  const handler = new AdminHandler(makeAcl(dir), makeDeniedLog(dir), mockMailClient(), { dryRun: true });
  assert.equal(handler.hasCommands('Please allow me in.'), false);
});

// ---------------------------------------------------------------------------
// executeCommands() — dry-run mode
// ---------------------------------------------------------------------------

test('executeCommands: /allow in dry-run does not mutate ACL', async () => {
  const dir = tmpDir();
  const acl = makeAcl(dir);
  const mail = mockMailClient();
  const handler = new AdminHandler(acl, makeDeniedLog(dir), mail, { dryRun: true });

  await handler.executeCommands('msg_1', '/allow user@example.com', 'admin@test.com');

  assert.equal(acl.allowedSenders.length, 0, 'dry-run should not mutate ACL');
  assert.equal(mail.calls.reply.length, 0, 'dry-run should not send reply email');
});

test('executeCommands: /deny in dry-run does not mutate ACL', async () => {
  const dir = tmpDir();
  const acl = makeAcl(dir);
  const mail = mockMailClient();
  const handler = new AdminHandler(acl, makeDeniedLog(dir), mail, { dryRun: true });

  await handler.executeCommands('msg_2', '/deny @evil.com', 'admin@test.com');

  assert.equal(acl.deniedSenders.length, 0, 'dry-run should not mutate denied list');
});

test('executeCommands: /status returns snapshot without side effects', async () => {
  const dir = tmpDir();
  const acl = makeAcl(dir);
  const mail = mockMailClient();
  const handler = new AdminHandler(acl, makeDeniedLog(dir), mail, { dryRun: true });

  await handler.executeCommands('msg_3', '/status', 'admin@test.com');
  // dry-run: no email sent, no errors
  assert.equal(mail.calls.reply.length, 0);
});

test('executeCommands: no-op when no commands in body', async () => {
  const dir = tmpDir();
  const handler = new AdminHandler(makeAcl(dir), makeDeniedLog(dir), mockMailClient(), { dryRun: true });
  // should return without error
  await handler.executeCommands('msg_4', 'Hi there, just saying hello.', 'admin@test.com');
});

// ---------------------------------------------------------------------------
// _buildReportBody()
// ---------------------------------------------------------------------------

test('_buildReportBody: includes sender and subject', () => {
  const dir = tmpDir();
  const handler = new AdminHandler(makeAcl(dir), makeDeniedLog(dir), mockMailClient(), { dryRun: true });

  const entries = [
    {
      message_id: 'msg_a',
      from_email: 'alice@example.com',
      from_name: 'Alice',
      subject: 'Hello World',
      received_at: '2026-06-01T08:00:00Z',
    },
    {
      message_id: 'msg_b',
      from_email: 'alice@example.com',
      from_name: 'Alice',
      subject: 'Second message',
      received_at: '2026-06-01T09:00:00Z',
    },
  ];

  const body = handler._buildReportBody(entries);
  assert.ok(body.includes('alice@example.com'), 'report should contain sender email');
  assert.ok(body.includes('Hello World'),       'report should contain subject');
  assert.ok(body.includes('Second message'),    'report should contain second subject');
  assert.ok(body.includes('/allow'),            'report footer should contain /allow instruction');
  assert.ok(body.includes('/deny'),             'report footer should contain /deny instruction');
});

test('_buildReportBody: groups multiple messages from same sender', () => {
  const dir = tmpDir();
  const handler = new AdminHandler(makeAcl(dir), makeDeniedLog(dir), mockMailClient(), { dryRun: true });

  const entries = [
    { message_id: 'a', from_email: 'spam@test.com', from_name: '', subject: 'msg1', received_at: new Date().toISOString() },
    { message_id: 'b', from_email: 'spam@test.com', from_name: '', subject: 'msg2', received_at: new Date().toISOString() },
    { message_id: 'c', from_email: 'other@test.com', from_name: '', subject: 'msg3', received_at: new Date().toISOString() },
  ];

  const body = handler._buildReportBody(entries);
  // spam@test.com 应该只出现一次作为「发件人」行（虽然有 2 封邮件）
  const senderLineCount = (body.match(/spam@test\.com/g) || []).length;
  assert.ok(senderLineCount >= 1, 'sender should appear at least once');
  assert.ok(body.includes('邮件数：2'), 'should show count of 2 messages from same sender');
});

// ---------------------------------------------------------------------------
// _sendReport() — dry-run
// ---------------------------------------------------------------------------

test('_sendReport: dry-run marks entries as reported without sending email', async () => {
  const dir = tmpDir();
  const acl = makeAcl(dir);
  // 配置 admin sender
  acl._static = {
    ...(acl._static || {}),
    admin_senders: ['admin@example.com'],
  };

  const log = makeDeniedLog(dir);
  log.record({ message_id: 'dml_1', from_email: 'bad@evil.com', from_name: '', subject: 'spam', received_at: new Date().toISOString() });
  log.record({ message_id: 'dml_2', from_email: 'bad@evil.com', from_name: '', subject: 'spam2', received_at: new Date().toISOString() });

  const mail = mockMailClient();
  const handler = new AdminHandler(acl, log, mail, { dryRun: true });

  await handler._sendReport(1);

  assert.equal(mail.calls.send.length, 0, 'dry-run should not send email');
  assert.equal(log.getUnreported().length, 0, 'all entries should be marked as reported');
});

test('_sendReport: does nothing when unreported count below threshold', async () => {
  const dir = tmpDir();
  const acl = makeAcl(dir);
  acl._static = { admin_senders: ['admin@example.com'] };

  const log = makeDeniedLog(dir);
  log.record({ message_id: 'dml_3', from_email: 'bad@evil.com', from_name: '', subject: 'spam', received_at: new Date().toISOString() });

  const mail = mockMailClient();
  const handler = new AdminHandler(acl, log, mail, { dryRun: true });

  await handler._sendReport(5); // threshold=5, only 1 entry → should not send
  assert.equal(log.getUnreported().length, 1, 'entries should remain unreported');
});

test('_sendReport: does nothing when no admin_senders configured', async () => {
  const dir = tmpDir();
  const log = makeDeniedLog(dir);
  log.record({ message_id: 'dml_4', from_email: 'bad@evil.com', from_name: '', subject: 'x', received_at: new Date().toISOString() });

  const mail = mockMailClient();
  const handler = new AdminHandler(makeAcl(dir), log, mail, { dryRun: true });

  await handler._sendReport(1);
  assert.equal(log.getUnreported().length, 1, 'no admin = no report, entries remain unreported');
});
