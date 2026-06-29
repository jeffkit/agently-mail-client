'use strict';
/**
 * Tests for BatchStore — 批处理队列持久化。
 *
 * Covers: enqueue / markReplied / markSkipped / markFailed /
 *         getQueued / getAll / get / cleanup / setLastReportAt
 *
 * Run: node --test tests/test-batch-store.js
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { BatchStore } = require('../src/batch-store');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-store-'));
  return new BatchStore(path.join(dir, 'batch-queue.json'));
}

function makeMsg(id, overrides = {}) {
  return {
    message_id: id,
    subject:    `Subject ${id}`,
    from:       { email: `sender${id}@example.com`, name: `Sender ${id}` },
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

test('operations on non-existent file do not throw', () => {
  const store = tmpStore();
  assert.doesNotThrow(() => store.getQueued());
  assert.doesNotThrow(() => store.getAll());
  assert.strictEqual(store.get('nonexistent'), null);
});

test('enqueue: adds a new entry in queued state', () => {
  const store = tmpStore();
  store.enqueue(makeMsg('msg1'), 'preview text');
  const queued = store.getQueued();
  assert.strictEqual(queued.length, 1);
  assert.strictEqual(queued[0].message_id, 'msg1');
  assert.strictEqual(queued[0].status, 'queued');
  assert.strictEqual(queued[0].body_snippet, 'preview text');
});

test('enqueue: ignores duplicate message_id (idempotent)', () => {
  const store = tmpStore();
  store.enqueue(makeMsg('msg1'), 'first');
  store.enqueue(makeMsg('msg1'), 'second');
  assert.strictEqual(store.getQueued().length, 1);
  assert.strictEqual(store.getQueued()[0].body_snippet, 'first');
});

test('enqueue: ignores missing message_id', () => {
  const store = tmpStore();
  store.enqueue({ subject: 'no id' }, 'snippet');
  assert.strictEqual(store.getQueued().length, 0);
});

test('enqueue: persists to disk', () => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-store-'));
  const file = path.join(dir, 'batch-queue.json');
  const s1 = new BatchStore(file);
  s1.enqueue(makeMsg('msg1'));

  const s2 = new BatchStore(file);
  assert.strictEqual(s2.getQueued().length, 1);
});

test('markReplied: sets status=replied and resolved_at', () => {
  const store = tmpStore();
  store.enqueue(makeMsg('msg1'));
  store.markReplied('msg1');
  const entry = store.get('msg1');
  assert.strictEqual(entry.status, 'replied');
  assert.ok(entry.resolved_at);
});

test('markReplied: silently ignores unknown id', () => {
  const store = tmpStore();
  assert.doesNotThrow(() => store.markReplied('nonexistent'));
});

test('markSkipped: sets status=skipped and resolved_at', () => {
  const store = tmpStore();
  store.enqueue(makeMsg('msg1'));
  store.markSkipped('msg1');
  const entry = store.get('msg1');
  assert.strictEqual(entry.status, 'skipped');
  assert.ok(entry.resolved_at);
});

test('markFailed: sets status=failed and error', () => {
  const store = tmpStore();
  store.enqueue(makeMsg('msg1'));
  store.markFailed('msg1', 'dispatch error');
  const entry = store.get('msg1');
  assert.strictEqual(entry.status, 'failed');
  assert.strictEqual(entry.error, 'dispatch error');
});

test('getQueued: returns only queued entries', () => {
  const store = tmpStore();
  store.enqueue(makeMsg('msg1'));
  store.enqueue(makeMsg('msg2'));
  store.enqueue(makeMsg('msg3'));
  store.markReplied('msg2');
  store.markSkipped('msg3');
  const queued = store.getQueued();
  assert.strictEqual(queued.length, 1);
  assert.strictEqual(queued[0].message_id, 'msg1');
});

test('getAll: returns all entries', () => {
  const store = tmpStore();
  store.enqueue(makeMsg('msg1'));
  store.enqueue(makeMsg('msg2'));
  store.markReplied('msg2');
  assert.strictEqual(store.getAll().length, 2);
});

test('getAll: filters by since timestamp', () => {
  const store = tmpStore();
  store.enqueue(makeMsg('old'));
  store.enqueue(makeMsg('new'));

  // Backdate the 'old' entry's queued_at directly (since enqueue sets it to now)
  store._data['old'].queued_at = new Date(Date.now() - 10000).toISOString();
  store._save();

  const since = new Date(Date.now() - 5000).toISOString();
  const result = store.getAll({ since });
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].message_id, 'new');
});

test('get: returns entry by message_id', () => {
  const store = tmpStore();
  store.enqueue(makeMsg('msg1'));
  const entry = store.get('msg1');
  assert.ok(entry);
  assert.strictEqual(entry.message_id, 'msg1');
});

test('get: returns null for unknown id', () => {
  const store = tmpStore();
  assert.strictEqual(store.get('unknown'), null);
});

test('cleanup: removes resolved entries older than retention', () => {
  const store = tmpStore();
  store.enqueue(makeMsg('old'));
  store.markReplied('old');
  // Backdate resolved_at beyond the 7-day retention window
  store._data['old'].resolved_at = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  store._save();

  store.enqueue(makeMsg('recent'));
  store.markReplied('recent');

  store.cleanup();
  assert.strictEqual(store.get('old'), null);
  assert.ok(store.get('recent'));
});

test('cleanup: keeps queued entries regardless of age', () => {
  const store = tmpStore();
  store.enqueue(makeMsg('old'));
  store._data['old'].queued_at = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  store._save();

  store.cleanup();
  assert.ok(store.get('old'));
});

test('setLastReportAt / getLastReportAt: persists across instances', () => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-store-'));
  const file = path.join(dir, 'batch-queue.json');
  const ts = new Date().toISOString();

  const s1 = new BatchStore(file);
  s1.setLastReportAt(ts);

  const s2 = new BatchStore(file);
  assert.strictEqual(s2.getLastReportAt(), ts);
});

test('setLastReportAt: does not clobber message entries', () => {
  const store = tmpStore();
  store.enqueue(makeMsg('msg1'));
  store.setLastReportAt(new Date().toISOString());
  assert.strictEqual(store.getQueued().length, 1);
});
