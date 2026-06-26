# AgentProc P0 协议

P0 是 agently-mail-client 与 AI Profile 之间的最小契约。任何能读环境变量、写 stdout 的程序都可以是 Profile。

## 输入（环境变量）

| 变量 | 说明 |
|------|------|
| `AGENT_MESSAGE` | 用户消息（邮件正文，已清理 HTML/引用/页脚） |
| `AGENT_SESSION_ID` | 续传 Session ID（空字符串 = 新会话） |
| `AGENT_SESSION_NAME` | 会话标识名，格式 `email-<sender>` |
| `AGENT_FROM_USER` | 发件人邮箱地址 |
| `AGENT_STREAMING` | 固定为 `1`，提示 Profile 可流式输出 |

## 输出（stdout）

Profile 在 stdout 上输出的每一行按前缀解释：

| 前缀 | 含义 |
|------|------|
| `AGENT_SESSION:<uuid>` | 新的 CLI 内部 session id，下次续传用 |
| `AGENT_PARTIAL:<json>` | 流式输出片段（可选） |
| `AGENT_ERROR:<json>` | 应用层错误（profile 正常退出，但报告了错误） |
| 其他行 | 回复正文（Markdown，转为 HTML 后发送） |

## 最小实现（echo.js）

```js
#!/usr/bin/env node
const msg = process.env.AGENT_MESSAGE || '(空消息)';
const sid = process.env.AGENT_SESSION_ID || '';

// 如果有 session，续传；没有就创建新的
const newSid = sid || require('crypto').randomUUID();
console.log(`AGENT_SESSION:${newSid}`);
console.log(`你发来的消息是：\n\n${msg}`);
```

## 会话持久化

agently-mail-client 管理两层会话状态，Profile 无需自行处理：

1. **对话历史**（`~/.agentproc/sessions/<sid>.jsonl`）：每轮 `{role, content}` 追加写入，由 `agentproc` 库管理
2. **CLI session id**（`~/.agentproc/email-sessions/<sid>.json`）：`AGENT_SESSION:` 输出的 id，下次调用时作为 `AGENT_SESSION_ID` 传入

Profile 只需要在 stdout 输出 `AGENT_SESSION:<id>`，其余由框架负责。
