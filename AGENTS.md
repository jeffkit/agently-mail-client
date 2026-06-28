# AGENTS.md — agently-mail-client

agently-mail-client 是一个独立的 **Email Channel Adapter**，基于 AgentProc P0 协议。
它轮询 Agently Mail（QQ Agent 邮箱），按主题前缀路由到不同 AI Profile，自动回复。

## 模块结构

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

## 核心数据流

```
mail.listUnread()
    ↓ 过滤自发邮件（filterSelfSent）
    ↓ mail.read(message_id)
    ↓ cleanBody()  ← 去 HTML / 去 quoted 引用 / 去 Agently 签名 / 截断
    ↓ dispatcher.resolveProfile(subject)  ← 解析 [profile-name] 前缀
    ↓ _sessionId()  ← references[0] || in_reply_to || rfc_message_id
    ↓ loadHistory(sessionId)  ← agentproc 会话历史
    ↓ _spawnProfile(AgentProc P0 env vars)  ← 启动 Profile 子进程
    ↓ 解析 AGENT_SESSION / AGENT_PARTIAL / AGENT_ERROR / 响应文本
    ↓ appendHistory() + saveAgentSessionId()
    ↓ mail.reply(message_id, response)
```

## AgentProc P0 协议

所有 Profile 通过 5 个环境变量接收输入：
`AGENT_MESSAGE` / `AGENT_SESSION_ID` / `AGENT_SESSION_NAME` / `AGENT_FROM_USER` / `AGENT_STREAMING`

Profile 通过 stdout 输出（可选）：
`AGENT_SESSION:<uuid>` + `AGENT_PARTIAL:<json>` + `AGENT_ERROR:<json>` + 响应文本

数据存储：
- 对话历史：`~/.agentproc/sessions/<sid>.jsonl`（agentproc 标准路径）
- CLI session id（如 claude --resume id）：`~/.agentproc/email-sessions/<sid>.json`
- 待重试队列、拒绝日志、ACL 动态配置：`~/.agently-mail-client/`

## 内置 Profile 说明

- **stream-json 系列**（claude/cursor/codebuddy）：使用 `_stream_json.js` 共享 helper
- **JSONL 系列**（codex）：独立解析 `thread.started` / `item.completed` 事件
- **plain text 系列**（agy）：从 log 文件提取 conversation ID
- 所有内置 Profile 均实现 **session resume + 降级重试**

## 本地测试

```bash
# 测试 echo profile（不需要任何 AI CLI）
AGENT_MESSAGE="hello" node profiles/echo.js

# 带 session 上下文
AGENT_MESSAGE="第二轮" AGENT_SESSION_ID="test-123" AGENT_FROM_USER="user@example.com" node profiles/echo.js

# 启动 bridge（dry-run 不实际发邮件）
DRY_RUN=1 POLL_INTERVAL_MS=120000 node bin/cli.js --config email-profiles.example.yaml
```

## 修改注意事项

- 修改 `dispatcher.js` 后验证 `cleanBody` / `resolveProfile` 逻辑
- 新增 Profile 参考 `profiles/echo.js` 最小实现，确保 AgentProc P0 协议兼容
- `email-profiles.yaml` 的 `args` 支持相对路径（相对于 yaml 文件目录）

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **agently-mail-client** (423 symbols, 874 relationships, 35 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

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
