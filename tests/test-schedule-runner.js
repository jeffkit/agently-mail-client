'use strict';
/**
 * Tests for ScheduleRunner config loading and task validation.
 *
 * These tests cover the non-cron parts: config parsing, valid/invalid task
 * filtering, and graceful handling of missing / malformed YAML.
 *
 * Run: node --test tests/test-schedule-runner.js
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { loadSchedulesConfig, ScheduleRunner } = require('../src/schedule-runner');

// ── loadSchedulesConfig ───────────────────────────────────────────────────────

test('loadSchedulesConfig: missing file returns empty tasks array', () => {
  const cfg = loadSchedulesConfig('/nonexistent/email-schedules.yaml');
  assert.deepStrictEqual(cfg, { tasks: [] });
});

test('loadSchedulesConfig: valid yaml is parsed', () => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-'));
  const file = path.join(dir, 'schedules.yaml');
  fs.writeFileSync(file, `
tasks:
  - name: test-task
    cron: "0 9 * * *"
    type: profile
    profile: echo
    message: hello
    to: user@example.com
    subject: Test
`);
  const cfg = loadSchedulesConfig(file);
  assert.strictEqual(cfg.tasks.length, 1);
  assert.strictEqual(cfg.tasks[0].name, 'test-task');
});

test('loadSchedulesConfig: non-array tasks key returns empty', () => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-'));
  const file = path.join(dir, 'schedules.yaml');
  fs.writeFileSync(file, 'tasks: "not an array"\n');
  const cfg = loadSchedulesConfig(file);
  assert.deepStrictEqual(cfg, { tasks: [] });
});

test('loadSchedulesConfig: empty file returns empty tasks', () => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-'));
  const file = path.join(dir, 'schedules.yaml');
  fs.writeFileSync(file, '');
  const cfg = loadSchedulesConfig(file);
  assert.deepStrictEqual(cfg, { tasks: [] });
});

// ── ScheduleRunner start/stop ─────────────────────────────────────────────────

function makeMockContext() {
  const mail = { send: async () => {} };
  const dispatcher = {
    config: { profiles: { echo: { command: 'node', args: [] } }, default: 'echo' },
    dispatchRaw: async () => ({ response: 'ok', profileName: 'echo' }),
  };
  return { mail, dispatcher };
}

test('ScheduleRunner: start() with empty config registers zero jobs', () => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-'));
  const file = path.join(dir, 'schedules.yaml');
  const { mail, dispatcher } = makeMockContext();
  const runner = new ScheduleRunner({ configPath: file, dispatcher, mailClient: mail });
  assert.doesNotThrow(() => runner.start());
  runner.stop();
});

test('ScheduleRunner: stop() is idempotent (can call multiple times)', () => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-'));
  const file = path.join(dir, 'schedules.yaml');
  const { mail, dispatcher } = makeMockContext();
  const runner = new ScheduleRunner({ configPath: file, dispatcher, mailClient: mail });
  runner.start();
  assert.doesNotThrow(() => { runner.stop(); runner.stop(); });
});

test('ScheduleRunner: tasks with enabled=false are skipped', () => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-'));
  const file = path.join(dir, 'schedules.yaml');
  fs.writeFileSync(file, `
tasks:
  - name: disabled-task
    cron: "* * * * *"
    type: profile
    enabled: false
    profile: echo
    message: hello
    to: user@example.com
    subject: Disabled
`);
  const { mail, dispatcher } = makeMockContext();
  const runner = new ScheduleRunner({ configPath: file, dispatcher, mailClient: mail });
  runner.start();
  assert.strictEqual(runner._jobs.length, 0);
  runner.stop();
});

test('ScheduleRunner: tasks missing name/cron are skipped', () => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-'));
  const file = path.join(dir, 'schedules.yaml');
  fs.writeFileSync(file, `
tasks:
  - cron: "* * * * *"
    type: profile
    profile: echo
    message: hello
    to: user@example.com
    subject: No Name
`);
  const { mail, dispatcher } = makeMockContext();
  const runner = new ScheduleRunner({ configPath: file, dispatcher, mailClient: mail });
  runner.start();
  assert.strictEqual(runner._jobs.length, 0);
  runner.stop();
});

test('ScheduleRunner: profile tasks missing required fields are skipped', () => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-'));
  const file = path.join(dir, 'schedules.yaml');
  fs.writeFileSync(file, `
tasks:
  - name: incomplete-task
    cron: "0 9 * * *"
    type: profile
    profile: echo
`);
  const { mail, dispatcher } = makeMockContext();
  const runner = new ScheduleRunner({ configPath: file, dispatcher, mailClient: mail });
  runner.start();
  assert.strictEqual(runner._jobs.length, 0);
  runner.stop();
});

test('ScheduleRunner: invalid cron expression is skipped', () => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-'));
  const file = path.join(dir, 'schedules.yaml');
  fs.writeFileSync(file, `
tasks:
  - name: bad-cron
    cron: "not-a-cron"
    type: profile
    profile: echo
    message: hello
    to: user@example.com
    subject: Bad Cron
`);
  const { mail, dispatcher } = makeMockContext();
  const runner = new ScheduleRunner({ configPath: file, dispatcher, mailClient: mail });
  runner.start();
  assert.strictEqual(runner._jobs.length, 0);
  runner.stop();
});

test('ScheduleRunner: builtin task with unknown handler is skipped', () => {
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-'));
  const file = path.join(dir, 'schedules.yaml');
  fs.writeFileSync(file, `
tasks:
  - name: no-handler
    cron: "0 9 * * *"
    type: builtin
    handler: nonexistent-handler
`);
  const { mail, dispatcher } = makeMockContext();
  const runner = new ScheduleRunner({ configPath: file, dispatcher, mailClient: mail });
  runner.start();
  assert.strictEqual(runner._jobs.length, 0);
  runner.stop();
});
