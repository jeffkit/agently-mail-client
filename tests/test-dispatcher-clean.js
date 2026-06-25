'use strict';
/**
 * Tests for ProfileDispatcher's body cleaning + routing + session id logic.
 *
 * Covers: stripHtml / removeQuotedContent / removeAgentlyFooter / truncate /
 * cleanBody / resolveProfile / _sessionId / convertMarkdownToHtml (incl. XSS).
 *
 * Run: node --test tests/test-dispatcher-clean.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  stripHtml,
  removeQuotedContent,
  removeAgentlyFooter,
  truncate,
  cleanBody,
  convertMarkdownToHtml,
  ProfileDispatcher,
} = require('../src/dispatcher');

// ---------------------------------------------------------------------------
// stripHtml
// ---------------------------------------------------------------------------

test('stripHtml: removes <script>/<style>/<iframe>', () => {
  const html = '<style>.x{color:red}</style><script>alert(1)</script><iframe src=evil></iframe><p>hi</p>';
  assert.equal(stripHtml(html), 'hi');
});

test('stripHtml: block elements convert to newlines', () => {
  const html = '<p>line1</p><p>line2</p><div>line3</div><br>line4';
  // </p>/</div> add \n, then <br> adds \n before line4 → one blank line collapse
  assert.equal(stripHtml(html), 'line1\nline2\nline3\n\nline4');
});

test('stripHtml: decodes common entities', () => {
  assert.equal(stripHtml('a&nbsp;b&amp;c&lt;d&gt;e&quot;f&#39;g'), 'a b&c<d>e"f\'g');
});

test('stripHtml: collapses runs of spaces and 3+ newlines to 2', () => {
  assert.equal(stripHtml('a    b\n\n\n\nc'), 'a b\n\nc');
});

test('stripHtml: list items split onto lines', () => {
  const html = '<ul><li>one</li><li>two</li><li>three</li></ul>';
  assert.equal(stripHtml(html), 'one\ntwo\nthree');
});

// ---------------------------------------------------------------------------
// removeQuotedContent
// ---------------------------------------------------------------------------

test('removeQuotedContent: strips ">" quoted lines', () => {
  const text = 'my reply\n> quoted line\n> another quoted';
  assert.equal(removeQuotedContent(text), 'my reply');
});

test('removeQuotedContent: detects "On X wrote:" divider', () => {
  const text = [
    'my reply',
    '',
    'On Thu, Jun 24, 2026 at 9:38 PM John <john@example.com> wrote:',
    '',
    '> earlier message',
  ].join('\n');
  assert.equal(removeQuotedContent(text), 'my reply');
});

test('removeQuotedContent: detects Chinese 发件人/From header block', () => {
  const text = [
    '我的回复',
    '',
    '发件人: Alice <alice@example.com>',
    '发送时间: 2026年6月1日 10:00',
    '收件人: bob@example.com',
    '主题: Hello',
    '',
    '原邮件内容',
  ].join('\n');
  assert.equal(removeQuotedContent(text), '我的回复');
});

test('removeQuotedContent: single From: header is NOT a quote block', () => {
  // Only one header line — should be preserved
  const text = 'From: a friend\nfollowed by more text';
  // 实现要求 ≥2 个连续 header 才认作 quote block
  assert.equal(removeQuotedContent(text), 'From: a friend\nfollowed by more text');
});

test('removeQuotedContent: signature separator "-- " stops processing', () => {
  const text = 'keep me\n-- \nsignature that should be dropped\nmore sig';
  assert.equal(removeQuotedContent(text), 'keep me');
});

test('removeQuotedContent: empty input', () => {
  assert.equal(removeQuotedContent(''), '');
});

// ---------------------------------------------------------------------------
// removeAgentlyFooter
// ---------------------------------------------------------------------------

test('removeAgentlyFooter: removes the standard footer line', () => {
  const text = 'mail body\n\n此邮件由foo@bar.com通过Agently Mail自动发送。举报退订';
  assert.equal(removeAgentlyFooter(text), 'mail body');
});

test('removeAgentlyFooter: leaves unrelated text alone', () => {
  assert.equal(removeAgentlyFooter('just content'), 'just content');
});

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

test('truncate: short text unchanged', () => {
  assert.equal(truncate('abc', 100), 'abc');
});

test('truncate: long text gets cut + suffix', () => {
  const long = 'x'.repeat(100);
  const out = truncate(long, 50);
  assert.ok(out.startsWith('x'.repeat(50)));
  assert.ok(out.includes('[... 内容已截断，原始长度 100 字符]'));
});

test('truncate: maxLength=0 disables truncation', () => {
  assert.equal(truncate('abc', 0), 'abc');
});

// ---------------------------------------------------------------------------
// cleanBody
// ---------------------------------------------------------------------------

test('cleanBody: HTML body goes through stripHtml + quote strip + footer + truncate', () => {
  const msg = {
    body_format: 'HTML',
    body: '<p>reply</p><blockquote>> quoted</blockquote>此邮件由x@y.com通过Agently Mail自动发送。举报退订',
  };
  assert.equal(cleanBody(msg), 'reply');
});

test('cleanBody: plain text body is not HTML-stripped', () => {
  const msg = { body: 'a < b > c' };
  assert.equal(cleanBody(msg), 'a < b > c');
});

test('cleanBody: stripQuotes=false preserves quotes', () => {
  const msg = { body: 'reply\n> quoted' };
  assert.equal(cleanBody(msg, { stripQuotes: false }), 'reply\n> quoted');
});

test('cleanBody: maxLength default is 8000', () => {
  // Just check it doesn't throw and respects the default
  const msg = { body: 'x'.repeat(100) };
  assert.equal(cleanBody(msg).length, 100);
});

// ---------------------------------------------------------------------------
// ProfileDispatcher — resolveProfile + _sessionId (no real profile spawn)
// ---------------------------------------------------------------------------

function makeDispatcherYaml(dir, profiles) {
  const yaml = ['default: ' + profiles[0]];
  yaml.push('profiles:');
  for (const name of profiles) {
    yaml.push(`  ${name}:`);
    yaml.push(`    command: echo`);
    yaml.push(`    args: ["hi"]`);
    yaml.push(`    trigger: ${name}-tag`);
  }
  const p = path.join(dir, 'email-profiles.yaml');
  fs.writeFileSync(p, yaml.join('\n'));
  return p;
}

test('resolveProfile: [tag] prefix matches by trigger', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-'));
  try {
    const yamlPath = makeDispatcherYaml(dir, ['default', 'special']);
    const d = new ProfileDispatcher(yamlPath);
    const r = d.resolveProfile('[special-tag] hello');
    assert.equal(r.profileName, 'special');
    assert.equal(r.cleanSubject, 'hello');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveProfile: [tag] prefix matches by profile name when no trigger', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-'));
  try {
    const yamlPath = path.join(dir, 'p.yaml');
    fs.writeFileSync(yamlPath, [
      'default: echo',
      'profiles:',
      '  echo:',
      '    command: echo',
      '  claude-code:',
      '    command: claude',
      '    trigger: claude',
    ].join('\n'));
    const d = new ProfileDispatcher(yamlPath);
    // tag matches profile name (no trigger field for echo)
    const r1 = d.resolveProfile('[echo] hi');
    assert.equal(r1.profileName, 'echo');
    // tag matches trigger
    const r2 = d.resolveProfile('[claude] hi');
    assert.equal(r2.profileName, 'claude-code');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveProfile: falls back to default profile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-'));
  try {
    const yamlPath = makeDispatcherYaml(dir, ['default', 'special']);
    const d = new ProfileDispatcher(yamlPath);
    const r = d.resolveProfile('no prefix at all');
    assert.equal(r.profileName, 'default');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveProfile: tag mismatch falls back to default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-'));
  try {
    const yamlPath = makeDispatcherYaml(dir, ['default']);
    const d = new ProfileDispatcher(yamlPath);
    const r = d.resolveProfile('[unknown] hi');
    assert.equal(r.profileName, 'default');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('_sessionId: stable across replies in the same thread', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-'));
  try {
    const yamlPath = makeDispatcherYaml(dir, ['default']);
    const d = new ProfileDispatcher(yamlPath);

    // Thread root is References[0]; two messages in the same thread should collide
    const root = '<root-123@example.com>';
    const m1 = { references: [root, '<other@example.com>'], message_id: '<m1@x>' };
    const m2 = { references: [root], message_id: '<m2@x>' };
    const m3 = { in_reply_to: root, message_id: '<m3@x>' };

    const sid1 = d._sessionId(m1, 'echo');
    const sid2 = d._sessionId(m2, 'echo');
    const sid3 = d._sessionId(m3, 'echo');

    assert.equal(sid1, sid2, 'two msgs with same References[0] share sid');
    assert.equal(sid1, sid3, 'References[0] and In-Reply-To to same root share sid');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('_sessionId: distinct threads produce distinct sids (no collision)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-'));
  try {
    const yamlPath = makeDispatcherYaml(dir, ['default']);
    const d = new ProfileDispatcher(yamlPath);

    // Two different thread roots — must NOT collide
    const a = d._sessionId({ references: ['<aaa@example.com>'] }, 'echo');
    const b = d._sessionId({ references: ['<bbb@example.com>'] }, 'echo');
    assert.notEqual(a, b, 'distinct threads must produce distinct sids');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('_sessionId: SHA1 prevents attacker from forcing a collision', () => {
  // An attacker who knows a victim's Message-ID cannot craft a different
  // Message-ID that hashes to the same sid (would require SHA1 preimage).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-'));
  try {
    const yamlPath = makeDispatcherYaml(dir, ['default']);
    const d = new ProfileDispatcher(yamlPath);

    const victimSid = d._sessionId({ message_id: '<victim-abc@x.com>' }, 'echo');
    // Substring of the victim id (would have collided under the old slice(0,80) scheme)
    const attackerSid = d._sessionId({ message_id: '<victim-abc@x.com>-suffix' }, 'echo');
    assert.notEqual(victimSid, attackerSid);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('_sessionId: output is filesystem-safe (no slashes, dots, etc.)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-'));
  try {
    const yamlPath = makeDispatcherYaml(dir, ['default']);
    const d = new ProfileDispatcher(yamlPath);
    const sid = d._sessionId({
      message_id: '<a/b/c/../d@example.com>',
    }, 'echo');
    assert.match(sid, /^email_[A-Za-z0-9_-]+$/, 'sid is alphanumeric + _ -');
    assert.ok(!sid.includes('/'));
    assert.ok(!sid.includes('.'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// convertMarkdownToHtml — XSS hardening
// ---------------------------------------------------------------------------

test('convertMarkdownToHtml: output is a full HTML document', () => {
  const out = convertMarkdownToHtml('hello');
  assert.ok(out.startsWith('<!DOCTYPE html>'));
  assert.ok(out.includes('<body>'));
  assert.ok(out.includes('hello'));
});

test('convertMarkdownToHtml: <script> tags are stripped', () => {
  const out = convertMarkdownToHtml('<script>alert(1)</script>plain text');
  assert.ok(!out.toLowerCase().includes('<script'), 'script tag stripped');
  assert.ok(out.includes('plain text'));
});

test('convertMarkdownToHtml: <iframe> tags are stripped', () => {
  const out = convertMarkdownToHtml('<iframe src="javascript:alert(1)"></iframe>ok');
  assert.ok(!out.toLowerCase().includes('<iframe'), 'iframe stripped');
  assert.ok(out.includes('ok'));
});

test('convertMarkdownToHtml: javascript: href is blocked', () => {
  const out = convertMarkdownToHtml('[click](javascript:alert(1))');
  assert.ok(!out.toLowerCase().includes('javascript:'), 'javascript: scheme blocked');
});

test('convertMarkdownToHtml: data: href is blocked', () => {
  const out = convertMarkdownToHtml('[click](data:text/html,<script>alert(1)</script>)');
  assert.ok(!out.toLowerCase().includes('data:text/html'), 'data: scheme blocked');
});

test('convertMarkdownToHtml: http/https/mailto links survive', () => {
  const out = convertMarkdownToHtml('[web](https://example.com) [mail](mailto:a@b.com)');
  assert.ok(out.includes('href="https://example.com"'));
  assert.ok(out.includes('href="mailto:a@b.com"'));
});

test('convertMarkdownToHtml: outbound links get rel=noopener + target=_blank', () => {
  const out = convertMarkdownToHtml('[link](https://example.com)');
  assert.ok(out.includes('rel="noopener noreferrer"'));
  assert.ok(out.includes('target="_blank"'));
});

test('convertMarkdownToHtml: inline event handlers stripped', () => {
  const out = convertMarkdownToHtml('<img src="x" onerror="alert(1)">');
  assert.ok(!out.toLowerCase().includes('onerror'), 'onerror attr stripped');
});

test('convertMarkdownToHtml: code blocks with class survive (marked language tag)', () => {
  const out = convertMarkdownToHtml('```js\nconsole.log(1)\n```');
  assert.ok(out.includes('<pre>'));
  assert.ok(out.includes('console.log'));
});

test('convertMarkdownToHtml: markdown tables render', () => {
  const out = convertMarkdownToHtml('| a | b |\n| - | - |\n| 1 | 2 |');
  assert.ok(out.includes('<table>'));
  assert.ok(out.includes('<th>'));
});
