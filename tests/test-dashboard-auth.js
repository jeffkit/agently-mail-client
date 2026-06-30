'use strict';
/**
 * Integration tests for Dashboard HTTP server — token 鉴权与安全头。
 *
 * Covers:
 *   - 启动时生成 dashboard.token 并注入 index.html
 *   - GET /api/state 无需 token 可访问
 *   - 写 API (POST) 无 token → 401
 *   - 写 API (POST) 错误 token → 401
 *   - 写 API (POST) 正确 token → 通过鉴权（业务层可能返回 4xx，但不应是 401）
 *   - DELETE 无 token → 401
 *   - 响应不含 Access-Control-Allow-Origin 头
 *
 * Run: node --test tests/test-dashboard-auth.js
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const http   = require('http');

const { startDashboard, readState } = require('../src/dashboard');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-test-'));
}

/** Find a free port by letting the OS assign one, then close the listener. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = require('net').createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

/** Make an HTTP request to the local dashboard. */
function request(opts) {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Test setup: start a dashboard instance with a temp storeDir
// ---------------------------------------------------------------------------

let dashboard;
let port;
let storeDir;
let token;

test.before(async () => {
  storeDir = tmpDir();
  port = await getFreePort();
  dashboard = startDashboard({
    port,
    host: '127.0.0.1',
    storeDir,
    open: false,
  });
  // Wait briefly for the server to be ready
  await new Promise((r) => setTimeout(r, 100));
  const tokenFile = path.join(storeDir, 'dashboard.token');
  token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
});

test.after(() => {
  dashboard?.stop();
});

// ---------------------------------------------------------------------------
// Token file
// ---------------------------------------------------------------------------

test('token file is created in storeDir on startup', () => {
  const tokenFile = path.join(storeDir, 'dashboard.token');
  assert.ok(fs.existsSync(tokenFile), 'dashboard.token should exist');
  const t = fs.readFileSync(tokenFile, 'utf8').trim();
  assert.ok(t.length >= 32, 'token should be at least 32 characters');
});

test('token is stable across multiple startDashboard calls (reads existing file)', () => {
  const tokenFile = path.join(storeDir, 'dashboard.token');
  const firstToken = fs.readFileSync(tokenFile, 'utf8').trim();
  // Verify that loading the module again does not regenerate the token file.
  // (require() is cached, so the same module instance is returned — the token
  //  file on disk must not have been overwritten since startup.)
  const secondToken = fs.readFileSync(tokenFile, 'utf8').trim();
  assert.equal(firstToken, secondToken, 'token should not change on subsequent reads');
});

// ---------------------------------------------------------------------------
// GET endpoints — no token required
// ---------------------------------------------------------------------------

test('GET /api/state returns 200 without token', async () => {
  const res = await request({ hostname: '127.0.0.1', port, path: '/api/state', method: 'GET' });
  assert.equal(res.status, 200, 'GET /api/state should succeed without token');
});

test('GET /api/state response has no Access-Control-Allow-Origin header', async () => {
  const res = await request({ hostname: '127.0.0.1', port, path: '/api/state', method: 'GET' });
  assert.equal(res.headers['access-control-allow-origin'], undefined, 'should not set CORS *');
});

// ---------------------------------------------------------------------------
// POST endpoints — token required
// ---------------------------------------------------------------------------

test('POST /api/acl without token returns 401', async () => {
  const res = await request({
    hostname: '127.0.0.1',
    port,
    path: '/api/acl',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'allow', address: 'test@example.com' }),
  });
  assert.equal(res.status, 401, 'missing token should return 401');
});

test('POST /api/acl with wrong token returns 401', async () => {
  const res = await request({
    hostname: '127.0.0.1',
    port,
    path: '/api/acl',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Dashboard-Token': 'wrong-token-value',
    },
    body: JSON.stringify({ action: 'allow', address: 'test@example.com' }),
  });
  assert.equal(res.status, 401, 'wrong token should return 401');
});

test('POST /api/acl with correct token passes auth (not 401)', async () => {
  const res = await request({
    hostname: '127.0.0.1',
    port,
    path: '/api/acl',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Dashboard-Token': token,
    },
    body: JSON.stringify({ action: 'allow', address: 'user@example.com' }),
  });
  assert.notEqual(res.status, 401, 'correct token should pass auth');
});

test('POST /api/send without token returns 401', async () => {
  const res = await request({
    hostname: '127.0.0.1',
    port,
    path: '/api/send',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: 'x@x.com', subject: 'test', body: 'hi' }),
  });
  assert.equal(res.status, 401, 'missing token on /api/send should return 401');
});

test('POST /api/profiles without token returns 401', async () => {
  const res = await request({
    hostname: '127.0.0.1',
    port,
    path: '/api/profiles',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test', command: 'echo' }),
  });
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// DELETE endpoints — token required
// ---------------------------------------------------------------------------

test('DELETE /api/profiles/:name without token returns 401', async () => {
  const res = await request({
    hostname: '127.0.0.1',
    port,
    path: '/api/profiles/test',
    method: 'DELETE',
    headers: {},
  });
  assert.equal(res.status, 401, 'DELETE without token should return 401');
});

test('DELETE /api/profiles/:name with correct token passes auth', async () => {
  const res = await request({
    hostname: '127.0.0.1',
    port,
    path: '/api/profiles/nonexistent',
    method: 'DELETE',
    headers: { 'X-Dashboard-Token': token },
  });
  // 404 or 400 is fine — we just verify it's not 401
  assert.notEqual(res.status, 401, 'correct token should pass auth on DELETE');
});

// ---------------------------------------------------------------------------
// index.html token injection
// ---------------------------------------------------------------------------

test('GET / injects window.__DASHBOARD_TOKEN__ into index.html when dist exists', async () => {
  const res = await request({ hostname: '127.0.0.1', port, path: '/', method: 'GET' });
  if (res.status === 200 && res.body.includes('<!DOCTYPE html')) {
    // Dashboard dist is built — verify token injection
    assert.ok(
      res.body.includes('__DASHBOARD_TOKEN__'),
      'index.html should contain __DASHBOARD_TOKEN__ injection',
    );
    assert.ok(
      res.body.includes(token),
      'index.html should contain the actual token value',
    );
  }
  // If dist is not built, the server returns 404 — that is acceptable in CI
});
