# AGENTS.md — agently-mail-client

> 独立的 Email Channel Adapter，基于 AgentProc P0 协议。
> 本文件是 AI / 开发者进入仓库的**唯一导航契约**。（`CLAUDE.md` 为本文件的软链，Claude Code 入口。）

agently-mail-client is a standalone **Email Channel Adapter** implementing the AgentProc P0 protocol. It polls an Agently Mail (QQ Agent) inbox, routes emails to AI CLI profiles by subject prefix, and auto-replies in HTML. Extracted from ilink-hub as the Node.js reference channel for a Universal Agent Gateway.

**Language**: Node.js (>=18), CommonJS. **No build step.**

## 模块结构 / Directory Structure

```
agently-mail-client/
  src/
    agently-mail.js     AgentlyMailClient — agently-cli subprocess 封装
    dispatcher.js       ProfileDispatcher — 路由 + 会话 + AgentProc P0 执行
    index.js            包入口，导出 createEmailBridge / createProfile
    index.d.ts          TypeScript 类型定义
    acl-config.js       ACL 配置加载
    sender-acl.js       Sender ACL 检查
    denied-log.js       ACL 拒绝日志
    admin-handler.js    Admin 命令处理
    pending-store.js    重试队列持久化
    mail-archive.js     邮件归档（inbox/thread 视图数据源）
    dashboard.js        内置 React SPA + JSON API（管理台）
  profiles/
    _stream_json.js     stream-json CLI 共享 helper（claude/cursor/codebuddy）
    claude-code.js      Claude Code CLI (claude)
    cursor.js           Cursor Agent CLI (agent)
    codebuddy.js        CodeBuddy Code CLI (codebuddy)
    codex.js            OpenAI Codex CLI (codex)
    agy.js              Antigravity CLI (agy)
    echo.js             内置回显 Profile（调试用）
  bin/
    cli.js              agently-mail CLI 入口
  docs/
    ARCHITECTURE.md     架构方案
    sender-acl-design.md  Sender ACL 设计文档
  email-profiles.example.yaml  配置文件示例
  email-acl.example.yaml       ACL 配置示例
```

## Commands

```bash
# Start the bridge (default config: ./email-profiles.yaml, 5-min poll)
npm start
node bin/cli.js
DRY_RUN=1 POLL_INTERVAL_MS=120000 node bin/cli.js --config email-profiles.example.yaml

# Run the test suite (node --test)
npm test
node --test tests/

# Run a single test file
node --test tests/test-sender-acl.js

# Manually verify a profile in isolation (no email server needed)
AGENT_MESSAGE="hello" AGENT_SESSION_ID="" node profiles/echo.js
AGENT_MESSAGE="第二轮" AGENT_SESSION_ID="test-123" AGENT_FROM_USER="user@example.com" node profiles/echo.js
```

Before running `npm start` against a real mailbox, the user must run `agently-cli auth login` once. The `agently-cli` binary is a peer dependency (`@tencent-qqmail/agently-cli`) and is expected on PATH.

## Architecture

The system is a **P0 protocol adapter**: emails come in, environment variables go to a child AI CLI process, its stdout comes back, a reply goes out.

### 核心数据流

```
AgentlyMailClient (src/agently-mail.js)
   │  wraps `agently-cli` subprocess; handles two-phase send confirmation
   ▼
createEmailBridge (src/index.js)
   │  orchestrates: poll → filter self-sent → global ACL →
   │                admin commands → dispatch → retry sweep
   ▼
ProfileDispatcher (src/dispatcher.js)
   │  • resolveProfile(subject) — matches [tag] prefix or falls back to default
   │  • cleanBody(msg) — strip HTML, quoted replies, Agently footer; truncate
   │  • _sessionId(msg, profile) — thread root via References[0] || In-Reply-To
   │  • _spawnProfile(cfg, msg, sid, ...) — spawnSync with AGENT_* env vars
   │  • session resume + fallback retry on expiry
   ▼
Profile subprocess (profiles/*.js)
   │  receives: AGENT_MESSAGE / AGENT_SESSION_ID / AGENT_SESSION_NAME /
   │            AGENT_FROM_USER / AGENT_STREAMING
   │  emits on stdout: AGENT_SESSION:<uuid> / AGENT_PARTIAL:<json> /
   │                   AGENT_ERROR:<json> / response text
   ▼
Reply via AgentlyMailClient.reply() (Markdown → HTML via marked)
```

### AgentProc P0 protocol

所有 Profile 通过 5 个环境变量接收输入：
`AGENT_MESSAGE` / `AGENT_SESSION_ID` / `AGENT_SESSION_NAME` / `AGENT_FROM_USER` / `AGENT_STREAMING`

Profile 通过 stdout 输出（可选）：
`AGENT_SESSION:<uuid>` + `AGENT_PARTIAL:<json>` + `AGENT_ERROR:<json>` + 响应文本

The only contract between the dispatcher and a profile. Any program that reads env vars and writes stdout can be a profile — `profiles/echo.js` is the minimal reference.

- **Input**: 5 env vars (`AGENT_MESSAGE`, `AGENT_SESSION_ID`, `AGENT_SESSION_NAME`, `AGENT_FROM_USER`, `AGENT_STREAMING`)
- **Output**: response text on stdout, optionally prefixed with `AGENT_SESSION:` / `AGENT_PARTIAL:` / `AGENT_ERROR:` lines
- **Per-profile session resume**: if a profile returns a new `AGENT_SESSION:<uuid>`, it's persisted in `~/.agentproc/email-sessions/<sid>.json` and passed back on the next message in the same email thread

### Session persistence (three layers, don't confuse them)

数据存储：

| What | Where | Key |
|------|-------|-----|
| Conversation history (`{role, content}` turns) | `~/.agentproc/sessions/<sid>.jsonl` | Managed by `agentproc` lib — agentproc's standard path |
| CLI-internal session id (e.g. `claude --resume <id>`) | `~/.agentproc/email-sessions/<sid>.json` | Sidecar JSON, one per (email thread × profile) |
| Mail archive (full inbox/thread bodies for dashboard) | `~/.agently-mail-client/mail-archive.jsonl` | Append-only JSONL, fed by bridge `read`/`reply` + dashboard compose |
| Pending/retry queue, denied log, dynamic ACL, poll cursor | `~/.agently-mail-client/` | Bridge's own state |

The session id is computed from the **email thread root** (References[0] → In-Reply-To → own Message-ID) combined with the profile name, so all replies in one thread share conversation context.

### Profile families in `profiles/`

- **stream-json** (`claude-code`, `cursor`, `codebuddy`) — share `_stream_json.js`, all emit the same `--output-format stream-json` event schema
- **JSONL** (`codex`) — parses `thread.started` / `item.completed` events independently
- **plain text** (`agy`) — extracts conversation id from a log file
- **echo** — debug profile, no AI CLI needed

所有内置 Profile 均实现 **session resume + 降级重试**（session 过期则启新会话）。

## Config files (runtime, gitignored)

- `email-profiles.yaml` — profile routing (copy from `email-profiles.example.yaml`). `args` paths resolve relative to the yaml file's directory.
- `email-acl.yaml` — sender ACL + admin senders + inspection report config (copy from `email-acl.example.yaml`). Optional; absence means open access.

ACL merging (in `src/acl-config.js`): `acl-dynamic.json` (runtime, admin-controlled) is layered on top of the static yaml. Dynamic `allowed` evicts from merged `denied`; admin_senders / deny_action / report settings come only from the static file.

Admin commands (`/allow`, `/deny`, `/reset`, `/status`) are sent in the email body from an `admin_senders` address; handled by `src/admin-handler.js`, which bypasses the normal dispatch path.

## Dashboard (管理台)

`src/dashboard.js` serves a built React SPA (`dashboard/`) plus a JSON API on `127.0.0.1:3030`. It is **read-mostly**; ACL/profile mutations write to the yaml/dynamic files, and the bridge hot-reloads the profiles yaml.

- **Inbox / thread view** (`/inbox`, `/inbox/:threadRoot`): backed by the **mail archive** (`src/mail-archive.js`, `~/.agently-mail-client/mail-archive.jsonl`). The archive is populated in two ways: (1) the bridge archives every `read()`/`reply()` result via `readAndArchive`/`replyAndArchive` helpers in `src/index.js`; (2) `GET /api/message/:id` live-`+read`s and caches when a message isn't archived yet. Thread grouping uses `references[0] || in_reply_to || rfc_message_id` (raw, no hash — same root as `_sessionId` but without the per-profile hash so the inbox shows the full thread across profiles). The list view is **archive-driven** (no auto-poll) to protect the 10 req/min RPM quota.
- **Compose** (`/compose`): `POST /api/send` / `/api/reply` / `/api/forward` wrap `AgentlyMailClient` and archive the outgoing mail (`source: 'dashboard'`). All live CLI calls consult the bridge-persisted `rpm-stats.json` and return 429 when the budget is low, since the dashboard is a separate process with its own token bucket.

## Editing notes / 修改注意事项

- 修改 `dispatcher.js` 后验证 `cleanBody`（HTML/quote/footer 剥离）与 `resolveProfile`（subject 前缀匹配）——最易出错。
- 新增 Profile 参考 `profiles/echo.js` 最小实现，确保 AgentProc P0 协议兼容；stream-json 系列可复用 `profiles/_stream_json.js`。
- `email-profiles.yaml` 的 `args` 支持相对路径（相对于 yaml 文件目录）。
- `marked` is the only non-trivial dependency — used by `convertMarkdownToHtml` for HTML reply formatting. Replies are always HTML; `bodyFormat: 'html'` is passed to `client.reply()`.
- The retry sweep runs on every poll interval at a half-interval offset (avoids bursting API calls alongside the main poll). Failed messages stay in the pending store across restarts.
- `agently-cli +read` marks messages as read server-side, so `PendingStore.add()` is called *before* `read()` to avoid losing mails that fail during dispatch.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **agently-mail-client** (1557 symbols, 2713 relationships, 133 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/agently-mail-client/context` | Codebase overview, check index freshness |
| `gitnexus://repo/agently-mail-client/clusters` | All functional areas |
| `gitnexus://repo/agently-mail-client/processes` | All execution flows |
| `gitnexus://repo/agently-mail-client/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
