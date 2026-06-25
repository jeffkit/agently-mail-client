#!/usr/bin/env node
'use strict';
/**
 * agently-mail-client CLI
 *
 * 用法：
 *   agently-mail-client [options]
 *
 * 选项：
 *   --config <path>     email-profiles.yaml 路径（默认 ./email-profiles.yaml）
 *   --interval <ms>     轮询间隔毫秒数（默认 300000 = 5分钟）
 *   --dry-run           不实际发送邮件（调试）
 *   --help, -h          显示帮助
 *
 * 环境变量（与命令行选项相同，命令行优先）：
 *   PROFILES_CONFIG     等同 --config
 *   POLL_INTERVAL_MS    等同 --interval
 *   DRY_RUN=1           等同 --dry-run
 */

const path = require('path');

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
agently-mail-client — Agently Mail Bridge — AgentProc Email Channel Adapter

Usage:
  agently-mail-client [options]

Options:
  --config <path>    Path to email-profiles.yaml (default: ./email-profiles.yaml)
  --interval <ms>    Poll interval in milliseconds (default: 300000)
  --dry-run          Print would-be replies without sending
  -h, --help         Show this help

Examples:
  # Start with default config
  agently-mail-client

  # Custom config and 1-minute poll
  agently-mail-client --config /etc/agently/profiles.yaml --interval 60000

  # Debug without sending emails
  DRY_RUN=1 agently-mail-client --interval 30000
`);
  process.exit(0);
}

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

const configArg = getArg('--config') || process.env.PROFILES_CONFIG;
const intervalArg = getArg('--interval') || process.env.POLL_INTERVAL_MS;
const dryRunArg = args.includes('--dry-run') || process.env.DRY_RUN === '1';

const { createEmailBridge } = require('../src/index');

createEmailBridge({
  profilesConfig: configArg ? path.resolve(configArg) : undefined,
  pollIntervalMs: intervalArg ? parseInt(intervalArg, 10) : undefined,
  dryRun: dryRunArg,
});
