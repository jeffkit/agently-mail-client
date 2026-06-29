'use strict';
/**
 * Tests for MailArchive — 本地邮件归档存储。
 *
 * Covers: archiveIncoming 去重 / archiveOutgoing / list 排序分页 /
 * getThread 归组 / listThreads 聚合 / computeThreadRoot。
 *
 * Run: node --test tests/test-mail-archive.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { MailArchive, computeThreadRoot } = require('../src/mail-archive');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-archive-'));
  return path.join(dir, 'mail-archive.jsonl');
}

function mkIncoming(overrides = {}) {
  return {
    message_id: 'msg_' + Math.random().toString(36).slice(2, 8),
    rfc_message_id: '<abc@example.com>',
    from: { email: 'alice@example.com', name: 'Alice' },
    to: [{ email: 'me@example.com', name: 'Me' }],
    subject: 'Hello',
    body_html: '<p>hi</p>',
    body_text: 'hi',
    created_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeThreadRoot
// ---------------------------------------------------------------------------

test('computeThreadRoot: references[0] wins', () => {
  const root = computeThreadRoot({
    references: ['<root@x>', '<other@x>'],
    in_reply_to: '<parent@x>',
    rfc_message_id: '<self@x>',
  });
  assert.equal(root, '<root@x>');
});

test('computeThreadRoot: falls back to in_reply_to', () => {
  assert.equal(computeThreadRoot({ in_reply_to: '<parent@x>', rfc_message_id: '<self@x>' }), '<parent@x>');
});

test('computeThreadRoot: falls back to rfc_message_id', () => {
  assert.equal(computeThreadRoot({ rfc_message_id: '<self@x>' }), '<self@x>');
});

test('computeThreadRoot: falls back to message_id', () => {
  assert.equal(computeThreadRoot({ message_id: 'msg_1' }), 'msg_1');
});

// ---------------------------------------------------------------------------
// archiveIncoming dedup + persistence
// ---------------------------------------------------------------------------

test('archiveIncoming: writes and can be read back', () => {
  const file = tmpFile();
  const arc = new MailArchive(file);
  const msg = mkIncoming({ message_id: 'msg_a' });
  assert.equal(arc.archiveIncoming(msg), true);
  // persisted to disk
  assert.ok(fs.existsSync(file));
  // re-read via a fresh instance
  const arc2 = new MailArchive(file);
  assert.equal(arc2.hasIncoming('msg_a'), true);
  assert.deepEqual(arc2.getByMessageId('msg_a').subject, 'Hello');
});

test('archiveIncoming: duplicate message_id is skipped', () => {
  const file = tmpFile();
  const arc = new MailArchive(file);
  const msg = mkIncoming({ message_id: 'msg_dup' });
  assert.equal(arc.archiveIncoming(msg), true);
  assert.equal(arc.archiveIncoming(msg), false);
  assert.equal(arc.size(), 1);
  // only one line on disk
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
});

// ---------------------------------------------------------------------------
// archiveOutgoing + thread grouping
// ---------------------------------------------------------------------------

test('archiveOutgoing + getThread: incoming and outgoing share thread_root', () => {
  const file = tmpFile();
  const arc = new MailArchive(file);
  const root = '<root-123@example.com>';
  arc.archiveIncoming(mkIncoming({
    message_id: 'msg_in1',
    references: [root],
    created_at: '2026-06-01T10:00:00Z',
  }));
  arc.archiveOutgoing({
    thread_root: root,
    in_reply_to: '<abc@example.com>',
    to: [{ email: 'alice@example.com' }],
    subject: 'Re: Hello',
    body_html: '<p>reply</p>',
    source: 'bridge',
    sent_at: '2026-06-01T11:00:00Z',
  });

  const thread = arc.getThread(root);
  assert.equal(thread.length, 2);
  // chronological order: incoming first, outgoing second
  assert.equal(thread[0].direction, 'in');
  assert.equal(thread[1].direction, 'out');
  assert.equal(thread[1].source, 'bridge');
});

test('archiveOutgoing: dedup by thread_root + sent_at when no message_id', () => {
  const file = tmpFile();
  const arc = new MailArchive(file);
  const entry = {
    thread_root: '<r@x>',
    to: [{ email: 'a@x' }],
    subject: 'Hi',
    body_html: '<p>x</p>',
    sent_at: '2026-06-01T11:00:00Z',
  };
  assert.equal(arc.archiveOutgoing(entry), true);
  assert.equal(arc.archiveOutgoing(entry), false);
  assert.equal(arc.size(), 1);
});

// ---------------------------------------------------------------------------
// list: direction filter + sort + pagination + search
// ---------------------------------------------------------------------------

test('list: sorts by created_at desc and paginates', () => {
  const file = tmpFile();
  const arc = new MailArchive(file);
  arc.archiveIncoming(mkIncoming({ message_id: 'm1', created_at: '2026-06-01T00:00:00Z' }));
  arc.archiveIncoming(mkIncoming({ message_id: 'm2', created_at: '2026-06-02T00:00:00Z' }));
  arc.archiveIncoming(mkIncoming({ message_id: 'm3', created_at: '2026-06-03T00:00:00Z' }));

  const all = arc.list({ limit: 10 });
  assert.deepEqual(all.map((r) => r.message_id), ['m3', 'm2', 'm1']);

  const page = arc.list({ limit: 2, offset: 1 });
  assert.deepEqual(page.map((r) => r.message_id), ['m2', 'm1']);
});

test('list: direction filter excludes outgoing when direction=in', () => {
  const file = tmpFile();
  const arc = new MailArchive(file);
  arc.archiveIncoming(mkIncoming({ message_id: 'm1', references: ['<r@x>'] }));
  arc.archiveOutgoing({ thread_root: '<r@x>', to: [{ email: 'a@x' }], subject: 'Re', sent_at: '2026-06-02T00:00:00Z' });

  const inbox = arc.list({ direction: 'in' });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].direction, 'in');
});

test('list: q matches subject case-insensitively', () => {
  const file = tmpFile();
  const arc = new MailArchive(file);
  arc.archiveIncoming(mkIncoming({ message_id: 'm1', subject: 'Project Alpha' }));
  arc.archiveIncoming(mkIncoming({ message_id: 'm2', subject: 'Other topic' }));
  const hits = arc.list({ q: 'alpha' });
  assert.deepEqual(hits.map((r) => r.message_id), ['m1']);
});

// ---------------------------------------------------------------------------
// listThreads
// ---------------------------------------------------------------------------

test('listThreads: groups by thread_root, sorts by last activity desc', () => {
  const file = tmpFile();
  const arc = new MailArchive(file);
  const rootA = '<rootA@x>';
  const rootB = '<rootB@x>';
  // Thread A: 1 incoming
  arc.archiveIncoming(mkIncoming({
    message_id: 'a1', references: [rootA], subject: 'Thread A',
    created_at: '2026-06-01T00:00:00Z',
  }));
  // Thread B: 1 incoming + 1 outgoing (more recent)
  arc.archiveIncoming(mkIncoming({
    message_id: 'b1', references: [rootB], subject: 'Thread B',
    created_at: '2026-06-02T00:00:00Z',
  }));
  arc.archiveOutgoing({
    thread_root: rootB, to: [{ email: 'x@y' }], subject: 'Re: Thread B',
    sent_at: '2026-06-03T00:00:00Z',
  });

  const threads = arc.listThreads({ limit: 10 });
  assert.equal(threads.length, 2);
  // B is more recent (last activity 06-03) → first
  assert.equal(threads[0].thread_root, rootB);
  assert.equal(threads[0].count, 2);
  assert.equal(threads[0].incoming_count, 1);
  // Thread subject should be the ORIGINAL (first) message's subject, not the
  // latest reply's "Re:" subject
  assert.equal(threads[0].subject, 'Thread B');
  assert.equal(threads[1].thread_root, rootA);
  assert.equal(threads[1].count, 1);
  assert.equal(threads[1].subject, 'Thread A');
});

test('listThreads: a message with no references starts its own thread', () => {
  const file = tmpFile();
  const arc = new MailArchive(file);
  arc.archiveIncoming(mkIncoming({
    message_id: 'solo', rfc_message_id: '<solo@x>', references: null,
  }));
  const threads = arc.listThreads();
  assert.equal(threads.length, 1);
  assert.equal(threads[0].thread_root, '<solo@x>');
});

// ---------------------------------------------------------------------------
// best-effort: missing file is fine
// ---------------------------------------------------------------------------

test('operations on non-existent file do not throw', () => {
  const arc = new MailArchive(path.join(os.tmpdir(), 'nope-' + Date.now(), 'x.jsonl'));
  assert.equal(arc.size(), 0);
  assert.deepEqual(arc.list(), []);
  assert.deepEqual(arc.getThread('<r@x>'), []);
});
