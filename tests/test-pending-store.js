'use strict';
/**
 * Tests for PendingStore — 邮件待回复状态追踪与重试队列。
 *
 * Covers: add / markReplied / markFailed / getPending (冷却逻辑) / cleanup
 *
 * Run: node --test tests/test-pending-store.js
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { PendingStore } = require('../src/pending-store');
const {
  PENDING_MAX_RETRIES,
  PENDING_RETRY_COOLDOWN_MS,
  PENDING_RETENTION_MS,
} = require('../src/constants');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-store-'));
  return new PendingStore(path.join(dir, 'pending.json'));
}

function makeSummary(id, overrides = {}) {
  return {
    message_id: id,
    subject: 'Test subject',
    from: { email: 'user@example.com', name: 'User' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// add()
// ---------------------------------------------------------------------------

test('add: records a new pending entry', () => {
  const store = tmpStore();
  store.add(makeSummary('msg_1'));
  const all = store.getPending();
  // 新消息在冷却期内不进入 getPending，通过内部 _data 验证
  assert.ok(store._data['msg_1'], 'entry should exist in _data');
  assert.equal(store._data['msg_1'].replied, false);
  assert.equal(store._data['msg_1'].retries, 0);
});

test('add: ignores summaries without message_id', () => {
  const store = tmpStore();
  store.add({ subject: 'no id' });
  assert.deepStrictEqual(store._data, {});
});

test('add: does not overwrite existing entry', () => {
  const store = tmpStore();
  store.add(makeSummary('msg_2'));
  const originalAddedAt = store._data['msg_2'].added_at;
  store.add(makeSummary('msg_2', { subject: 'updated' }));
  assert.equal(store._data['msg_2'].subject, 'Test subject', 'should keep original subject');
  assert.equal(store._data['msg_2'].added_at, originalAddedAt, 'added_at unchanged');
});

test('add: persists to disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-store-'));
  const file = path.join(dir, 'pending.json');
  const s1 = new PendingStore(file);
  s1.add(makeSummary('msg_persist'));
  const s2 = new PendingStore(file);
  s2._load();
  assert.ok(s2._data['msg_persist'], 'entry survives across instances');
});

// ---------------------------------------------------------------------------
// markReplied()
// ---------------------------------------------------------------------------

test('markReplied: sets replied=true and replied_at', () => {
  const store = tmpStore();
  store.add(makeSummary('msg_3'));
  store.markReplied('msg_3');
  assert.equal(store._data['msg_3'].replied, true);
  assert.ok(store._data['msg_3'].replied_at, 'replied_at should be set');
});

test('markReplied: silently ignores unknown id', () => {
  const store = tmpStore();
  assert.doesNotThrow(() => store.markReplied('no_such_id'));
});

// ---------------------------------------------------------------------------
// markFailed()
// ---------------------------------------------------------------------------

test('markFailed: increments retries and stores error', () => {
  const store = tmpStore();
  store.add(makeSummary('msg_4'));
  store.markFailed('msg_4', 'model unavailable');
  assert.equal(store._data['msg_4'].retries, 1);
  assert.equal(store._data['msg_4'].last_error, 'model unavailable');
  assert.ok(store._data['msg_4'].last_failed_at, 'last_failed_at should be set');
});

test('markFailed: increments retries cumulatively', () => {
  const store = tmpStore();
  store.add(makeSummary('msg_5'));
  store.markFailed('msg_5', 'err1');
  store.markFailed('msg_5', 'err2');
  assert.equal(store._data['msg_5'].retries, 2);
  assert.equal(store._data['msg_5'].last_error, 'err2');
});

test('markFailed: silently ignores unknown id', () => {
  const store = tmpStore();
  assert.doesNotThrow(() => store.markFailed('no_such_id', 'some error'));
});

// ---------------------------------------------------------------------------
// getPending() — 冷却逻辑
// ---------------------------------------------------------------------------

test('getPending: excludes entries within initial cooldown window', () => {
  const store = tmpStore();
  store.add(makeSummary('msg_6'));
  // 刚 add() 的消息必须等满 RETRY_COOLDOWN_MS，不应出现在结果中
  const pending = store.getPending();
  assert.equal(pending.length, 0, 'new entry should be in cooldown');
});

test('getPending: includes entry after cooldown has passed', () => {
  const store = tmpStore();
  store.add(makeSummary('msg_7'));
  // 将 added_at 设置到足够久之前
  store._data['msg_7'].added_at = new Date(Date.now() - PENDING_RETRY_COOLDOWN_MS - 1000).toISOString();
  const pending = store.getPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].message_id, 'msg_7');
});

test('getPending: excludes replied entries', () => {
  const store = tmpStore();
  store.add(makeSummary('msg_8'));
  store._data['msg_8'].added_at = new Date(Date.now() - PENDING_RETRY_COOLDOWN_MS - 1000).toISOString();
  store.markReplied('msg_8');
  assert.equal(store.getPending().length, 0, 'replied entry should not be in pending');
});

test('getPending: excludes entries that reached max retries', () => {
  const store = tmpStore();
  store.add(makeSummary('msg_9'));
  store._data['msg_9'].added_at = new Date(Date.now() - PENDING_RETRY_COOLDOWN_MS - 1000).toISOString();
  store._data['msg_9'].retries = PENDING_MAX_RETRIES;
  assert.equal(store.getPending().length, 0, 'max-retried entry should not be in pending');
});

test('getPending: excludes entry still in failure cooldown', () => {
  const store = tmpStore();
  store.add(makeSummary('msg_10'));
  // 让初始冷却过期
  store._data['msg_10'].added_at = new Date(Date.now() - PENDING_RETRY_COOLDOWN_MS - 1000).toISOString();
  // 但 last_failed_at 刚刚
  store._data['msg_10'].last_failed_at = new Date().toISOString();
  assert.equal(store.getPending().length, 0, 'recently failed entry should be in failure cooldown');
});

test('getPending: includes entry after failure cooldown has passed', () => {
  const store = tmpStore();
  store.add(makeSummary('msg_11'));
  store._data['msg_11'].added_at = new Date(Date.now() - PENDING_RETRY_COOLDOWN_MS - 1000).toISOString();
  store._data['msg_11'].retries = 1;
  store._data['msg_11'].last_failed_at = new Date(Date.now() - PENDING_RETRY_COOLDOWN_MS - 1000).toISOString();
  assert.equal(store.getPending().length, 1, 'entry past failure cooldown should be pending');
});

// ---------------------------------------------------------------------------
// cleanup()
// ---------------------------------------------------------------------------

test('cleanup: removes replied entries older than retention period', () => {
  const store = tmpStore();
  store.add(makeSummary('msg_old'));
  store.markReplied('msg_old');
  // 将 replied_at 设置到很久之前
  store._data['msg_old'].replied_at = new Date(Date.now() - PENDING_RETENTION_MS - 1000).toISOString();
  store.cleanup();
  assert.equal(store._data['msg_old'], undefined, 'old replied entry should be removed');
});

test('cleanup: keeps recently replied entries', () => {
  const store = tmpStore();
  store.add(makeSummary('msg_recent'));
  store.markReplied('msg_recent');
  store.cleanup();
  assert.ok(store._data['msg_recent'], 'recent replied entry should be kept');
});

test('cleanup: keeps unreplied entries regardless of age', () => {
  const store = tmpStore();
  store.add(makeSummary('msg_unreplied'));
  store._data['msg_unreplied'].added_at = new Date(Date.now() - PENDING_RETENTION_MS - 1000).toISOString();
  store.cleanup();
  assert.ok(store._data['msg_unreplied'], 'unreplied entry should not be removed by cleanup');
});
