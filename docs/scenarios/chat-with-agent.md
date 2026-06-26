# 场景一：邮箱即聊天窗口

> 适合：邮箱主人直接与 Agent 交互，像发短信一样用邮件聊天。

## 场景描述

你有一个 Agently Mail 邮箱地址。给它发邮件，AI 秒速回复。同一邮件线程里持续对话，Agent 自动记住上下文——就像在用一个没有 App 的 AI 聊天工具。

```
你                              Agent
 │                                │
 │── "帮我写一段 Python 排序代码" ──▶│
 │                                │── 回复代码 ──▶
 │── "加上单元测试" ───────────────▶│  （同一线程，记住上文）
 │                                │── 回复带测试的完整代码 ──▶
```

## 配置

无需特殊配置，默认行为即是此模式。确保 `email-profiles.yaml` 有一个默认 Profile：

```yaml
default: claude-code

profiles:
  claude-code:
    command: node
    args: [./profiles/claude-code.js]
    trigger: claude
```

## 使用方式

### 发起新对话

直接发一封新邮件：

```
Subject: 帮我分析这段日志
Body: [粘贴日志内容]
```

### 指定 Agent

在主题加 `[profile名]` 前缀：

| 主题前缀 | 路由到 |
|---------|--------|
| `[claude] 问题` | Claude Code |
| `[cursor] 问题` | Cursor Agent |
| `[codex] 问题`  | OpenAI Codex |
| 无前缀          | 默认 Profile |

### 继续对话

直接回复那封邮件（Reply），Agent 自动识别这是同一线程，带着历史上下文回答。

::: tip 线程识别机制
Agent 通过邮件头的 `References` / `In-Reply-To` 字段识别线程。只要是同一封邮件的 Reply，无论中间间隔多久，都能续接上下文。
:::

## 常见用途

- **代码问答**：粘贴代码片段，让 Agent 解释、优化、找 Bug
- **文档起草**：让 Agent 帮你写邮件草稿、报告、总结
- **快速查询**：出门在外只有邮件客户端时，当作 AI 助手用
- **异步协作**：给 Agent 布置任务，不用实时等待，结果直接回到收件箱
