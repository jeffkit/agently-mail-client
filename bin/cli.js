#!/usr/bin/env node
'use strict';
/**
 * agently-mail CLI
 *
 * 子命令：
 *   agently-mail              启动邮件桥（默认）
 *   agently-mail init         在当前目录生成配置文件
 *   agently-mail dashboard    启动本地管理面板
 *
 * 选项（邮件桥模式）：
 *   --config <path>     email-profiles.yaml 路径（默认 ./email-profiles.yaml）
 *   --interval <ms>     最大轮询间隔毫秒数（默认 900000 = 15分钟）
 *   --no-adaptive       关闭自适应轮询（固定间隔）
 *   --dry-run           不实际发送邮件（调试）
 *
 * 选项（dashboard 模式）：
 *   --port <port>       监听端口（默认 3030）
 *   --host <host>       监听地址（默认 127.0.0.1）
 *   --no-open           不自动打开浏览器
 *
 * 环境变量：
 *   PROFILES_CONFIG     等同 --config
 *   POLL_INTERVAL_MS    等同 --interval
 *   DRY_RUN=1           等同 --dry-run
 *   ADAPTIVE_POLLING=0  等同 --no-adaptive
 */

const path = require('path');
const fs   = require('fs');

const args    = process.argv.slice(2);
const subcmd  = args[0];
const subargs = args.slice(['dashboard', 'init'].includes(subcmd) ? 1 : 0);

function getArg(list, flag) {
  const i = list.indexOf(flag);
  return i !== -1 && i + 1 < list.length ? list[i + 1] : null;
}
function hasFlag(list, flag) { return list.includes(flag); }

// ── --help ───────────────────────────────────────────────────────────────────

if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
  console.log(`
agently-mail — Agently Mail Bridge — AgentProc Email Channel Adapter

Usage:
  agently-mail init                   Generate config files in current directory
  agently-mail [options]              Start the email bridge
  agently-mail dashboard [options]    Start the local dashboard UI

Bridge options:
  --config <path>    Path to email-profiles.yaml (default: ./email-profiles.yaml)
  --interval <ms>    Poll interval in milliseconds (default: 900000)
  --dry-run          Print would-be replies without sending
  -h, --help         Show this help

Dashboard options:
  --port <port>      Dashboard port (default: 3030)
  --host <host>      Listen address (default: 127.0.0.1)
  --no-open          Don't open browser automatically

Examples:
  agently-mail init
  agently-mail
  agently-mail --config ./email-profiles.yaml --interval 60000
  DRY_RUN=1 agently-mail --interval 30000
  agently-mail dashboard
  agently-mail dashboard --port 8080
`);
  process.exit(0);
}

// ── init 子命令 ───────────────────────────────────────────────────────────────

if (subcmd === 'init') {
  const pkgDir   = path.resolve(__dirname, '..');
  const destDir  = process.cwd();
  const files = [
    { src: 'email-profiles.example.yaml',   dest: 'email-profiles.yaml'   },
    { src: 'email-acl.example.yaml',        dest: 'email-acl.yaml'        },
    { src: 'email-schedules.example.yaml',  dest: 'email-schedules.yaml'  },
  ];

  let anyWritten = false;
  for (const { src, dest } of files) {
    const destPath = path.join(destDir, dest);
    if (fs.existsSync(destPath)) {
      console.log(`  已存在，跳过：${dest}`);
      continue;
    }
    fs.copyFileSync(path.join(pkgDir, src), destPath);
    console.log(`  已创建：${dest}`);
    anyWritten = true;
  }

  if (anyWritten) {
    console.log(`
配置文件已生成。下一步：
  1. 编辑 email-profiles.yaml  — 配置 AI Profile 路由
  2. 编辑 email-acl.yaml       — 配置访问控制（可选）
  3. agently-cli auth login    — 登录 Agently Mail（首次需要）
  4. agently-mail              — 启动！

文档：https://jeffkit.github.io/agently-mail-client/
`);
  } else {
    console.log('\n所有配置文件已存在，无需重新生成。');
  }
  process.exit(0);
}

// ── dashboard 子命令 ──────────────────────────────────────────────────────────

if (subcmd === 'dashboard') {
  const { startDashboard } = require('../src/dashboard');
  const configArg  = getArg(subargs, '--config') || process.env.PROFILES_CONFIG;
  const aclArg     = getArg(subargs, '--acl-config');
  const portArg    = getArg(subargs, '--port');
  const hostArg    = getArg(subargs, '--host');
  const noOpen     = hasFlag(subargs, '--no-open');

  startDashboard({
    port:           portArg ? parseInt(portArg, 10) : 3030,
    host:           hostArg || '127.0.0.1',
    profilesConfig: configArg ? path.resolve(configArg) : undefined,
    aclConfig:      aclArg   ? path.resolve(aclArg)    : undefined,
    open:           !noOpen,
  });
  return;
}

// ── 邮件桥（默认）────────────────────────────────────────────────────────────

const configArg      = getArg(subargs, '--config') || process.env.PROFILES_CONFIG;
const intervalArg    = getArg(subargs, '--interval') || process.env.POLL_INTERVAL_MS;
const dryRunArg      = hasFlag(subargs, '--dry-run') || process.env.DRY_RUN === '1';
const noAdaptiveArg  = hasFlag(subargs, '--no-adaptive') || process.env.ADAPTIVE_POLLING === '0';

const { createEmailBridge } = require('../src/index');

createEmailBridge({
  profilesConfig:   configArg   ? path.resolve(configArg)  : undefined,
  pollIntervalMs:   intervalArg ? parseInt(intervalArg, 10) : undefined,
  adaptivePolling:  !noAdaptiveArg,
  dryRun:           dryRunArg,
});
