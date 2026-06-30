#!/usr/bin/env node
'use strict';
/**
 * 分析 upstream-calls.jsonl —— 上游 agently-cli 调用取证日志。
 *
 * 用法：
 *   node scripts/analyze-upstream-calls.js              # 汇总
 *   node scripts/analyze-upstream-calls.js --hours 24   # 只看最近 24h
 *   node scripts/analyze-upstream-calls.js --timeline   # 额外打印 429/限流时间线
 *
 * 日志路径：~/.agently-mail-client/upstream-calls.jsonl
 * 字段：ts, epoch_ms, seq, caller, pid, args, throttle_wait_ms,
 *       duration_ms, status, exit_code, server_msg, server_code, rpm
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_FILE = process.env.UPSTREAM_LOG_FILE ||
  path.join(os.homedir(), '.agently-mail-client', 'upstream-calls.jsonl');

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let sinceHours = 0;
let showTimeline = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--hours' || a === '-h') { sinceHours = parseFloat(argv[++i]); }
  else if (a === '--timeline' || a === '-t') { showTimeline = true; }
  else if (a === '--help') {
    console.log(__filename.match(/\/\*[\s\S]*?\*\//)[0].replace(/^\s*\*/gm, '').trim());
    process.exit(0);
  }
}

if (!fs.existsSync(LOG_FILE)) {
  console.error(`日志文件不存在: ${LOG_FILE}`);
  console.error('请确认 bridge/dashboard 已用新代码重启，且 AGENTLY_UPSTREAM_LOG!=0');
  process.exit(1);
}

const sinceMs = sinceHours > 0 ? Date.now() - sinceHours * 3600_000 : 0;

// ── 读取 & 过滤 ──────────────────────────────────────────────────────────────
const raw = fs.readFileSync(LOG_FILE, 'utf8');
const records = raw.split('\n')
  .filter(Boolean)
  .map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  })
  .filter(Boolean)
  .filter((r) => r.epoch_ms >= sinceMs);

if (records.length === 0) {
  console.log('（没有匹配的日志记录）');
  console.log(`日志文件: ${LOG_FILE}`);
  if (sinceHours > 0) console.log(`过滤: 最近 ${sinceHours}h`);
  process.exit(0);
}

records.sort((a, b) => a.epoch_ms - b.epoch_ms);

// ── 汇总 ─────────────────────────────────────────────────────────────────────
const byStatus = {};
const byCaller = {};
const byCallerStatus = {};
let firstTs = records[0].ts;
let lastTs = records[records.length - 1].ts;
const spanH = (records[records.length - 1].epoch_ms - records[0].epoch_ms) / 3600_000;

for (const r of records) {
  byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  byCaller[r.caller] = (byCaller[r.caller] || 0) + 1;
  const k = `${r.caller}/${r.status}`;
  byCallerStatus[k] = (byCallerStatus[k] || 0) + 1;
}

// 每小时桶（按调用方 + 状态）
const hourBuckets = {}; // 'YYYY-MM-DD HH' -> { caller -> { status -> n } }
for (const r of records) {
  const d = new Date(r.epoch_ms);
  const key = d.toISOString().slice(0, 13); // 'YYYY-MM-DDTHH'
  const b = (hourBuckets[key] = hourBuckets[key] || {});
  const c = (b[r.caller] = b[r.caller] || {});
  c[r.status] = (c[r.status] || 0) + 1;
}

// 突发检测：任意 60s 滑窗内的调用数
let maxBurst = { count: 0, around: null };
for (let i = 0; i < records.length; i++) {
  let j = i;
  while (j < records.length && records[j].epoch_ms - records[i].epoch_ms < 60_000) j++;
  const count = j - i;
  if (count > maxBurst.count) maxBurst = { count, around: records[i].ts, end: records[j - 1].ts };
}

// 调用间隔分布
const gaps = [];
for (let i = 1; i < records.length; i++) {
  gaps.push(records[i].epoch_ms - records[i - 1].epoch_ms);
}
gaps.sort((a, b) => a - b);
const gapMedian = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
const gapMin = gaps.length ? gaps[0] : 0;
const gapMax = gaps.length ? gaps[gaps.length - 1] : 0;

// 操作类型（args[0..2]）
const byOp = {};
for (const r of records) {
  const op = (r.args || []).slice(0, 3).join(' ');
  byOp[op] = (byOp[op] || 0) + 1;
}

// ── 输出 ─────────────────────────────────────────────────────────────────────
const pct = (n) => records.length ? `${(n / records.length * 100).toFixed(1)}%` : '0%';
const fmtMs = (ms) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

console.log('═══ 上游调用分析 ═══');
console.log(`日志文件       : ${LOG_FILE}`);
console.log(`时间范围       : ${firstTs} → ${lastTs}`);
console.log(`跨度           : ${spanH.toFixed(2)}h`);
if (sinceHours > 0) console.log(`过滤           : 最近 ${sinceHours}h`);
console.log(`总调用数       : ${records.length}`);
console.log();
console.log('— 按状态 —');
for (const [s, n] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s.padEnd(12)} ${String(n).padStart(6)}  ${pct(n)}`);
}
console.log();
console.log('— 按调用方 —');
for (const [c, n] of Object.entries(byCaller).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${c.padEnd(12)} ${String(n).padStart(6)}  ${pct(n)}  (${(n / Math.max(spanH, 0.01)).toFixed(2)}/h)`);
}
console.log();
console.log('— 按调用方×状态 —');
for (const [k, n] of Object.entries(byCallerStatus).sort()) {
  console.log(`  ${k.padEnd(20)} ${String(n).padStart(6)}`);
}
console.log();
console.log('— 按操作类型 —');
for (const [op, n] of Object.entries(byOp).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${(op || '(empty)').padEnd(28)} ${String(n).padStart(6)}`);
}
console.log();
console.log('— 调用间隔 —');
console.log(`  min=${fmtMs(gapMin)}  median=${fmtMs(gapMedian)}  max=${fmtMs(gapMax)}  (共 ${gaps.length} 段)`);
console.log();
console.log('— 最大 60s 突发 —');
console.log(`  ${maxBurst.count} 次 / 60s  @ ${maxBurst.around}`);
console.log();

console.log('— 每小时调用数（含 429 标记）—');
const sortedHours = Object.keys(hourBuckets).sort();
for (const key of sortedHours) {
  const b = hourBuckets[key];
  let total = 0, r429 = 0;
  const parts = [];
  for (const [caller, st] of Object.entries(b)) {
    let cTotal = 0, c429 = 0;
    for (const [status, n] of Object.entries(st)) {
      cTotal += n; total += n;
      if (status === '429') { c429 += n; r429 += n; }
    }
    parts.push(`${caller}:${cTotal}${c429 ? `(429:${c429})` : ''}`);
  }
  const flag = r429 ? ' ⚠429' : '';
  console.log(`  ${key}  total=${String(total).padStart(3)}  ${parts.join('  ')}${flag}`);
}

// ── 429 时间线 ──────────────────────────────────────────────────────────────
if (showTimeline) {
  console.log();
  console.log('— 429 / 限流时间线 —');
  const r429s = records.filter((r) => r.status === '429');
  if (r429s.length === 0) {
    console.log('  （无 429 记录）');
  } else {
    for (const r of r429s) {
      console.log(`  ${r.ts}  ${r.caller}  ${(r.args || []).slice(0, 3).join(' ')}  [${r.server_code ?? ''}] ${r.server_msg || ''}`);
    }
  }
}

console.log();
console.log(`提示：详细查看 429 时间线用 --timeline；只看近期用 --hours N`);
