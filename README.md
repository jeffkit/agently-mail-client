# agently-mail-client

[![CI](https://github.com/jeffkit/agently-mail-client/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffkit/agently-mail-client/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/agently-mail-client.svg)](https://www.npmjs.com/package/agently-mail-client)
[![license](https://img.shields.io/npm/l/agently-mail-client.svg)](https://github.com/jeffkit/agently-mail-client/blob/main/LICENSE)

**Email Channel Adapter** —— 让任意 AI CLI（Claude Code、Cursor、agy 等）可以通过邮件被调用。

轮询 Agently Mail（QQ Agent 邮箱）收件箱，按邮件主题前缀路由到对应 AI Profile，自动以 HTML 格式回复。

## 极速上手

> 🤖 **推荐方式**：让 Agent 帮你安装和配置。将 [SKILL.md](./SKILL.md) 交给任意 AI Agent，说「按照这个 Skill 帮我把这个项目跑起来」即可全程自动化。

手动安装步骤：

```bash
# 1. 安装 agently-cli（Agently Mail 的命令行工具）
npm install -g @tencent-qqmail/agently-cli

# 2. 登录授权（会打开浏览器完成 OAuth）
agently-cli auth login

# 3. 确认邮箱地址
agently-cli +me

# 4. 克隆本项目并安装依赖
git clone https://github.com/jeffkit/agently-mail-client.git
cd agently-mail-client
npm install

# 5. 创建配置文件
cp email-profiles.example.yaml email-profiles.yaml

# 6. 启动（每 60 秒轮询一次邮箱）
POLL_INTERVAL_MS=60000 node bin/cli.js --config email-profiles.yaml
```

## 使用方法

启动后，给你的 Agently 邮箱地址发一封邮件：

- **默认路由**：主题任意内容 → 使用 `default` profile（默认是 `claude-code`）
- **指定 profile**：主题加 `[profile-name]` 前缀，例如 `[cursor] 帮我看这段代码`

```bash
# 调试模式：DRY_RUN=1 不实际发送邮件，echo profile 无需 AI CLI
DRY_RUN=1 POLL_INTERVAL_MS=30000 node bin/cli.js --config email-profiles.example.yaml
```

## 工作原理

```
Agently Mail 收件箱
   ↓ 轮询（agently-cli）
ProfileDispatcher  →  resolveProfile(主题)  →  [profile] 前缀匹配
   ↓ cleanBody（去 HTML / 去引用 / 去签名 / 截断）
启动 Profile 子进程（AGENT_MESSAGE / AGENT_SESSION_ID / ...）→ stdout
   ↓ convertMarkdownToHtml()
自动回复（HTML 格式）
```

任何能读取环境变量、将结果写到 stdout 的程序都可以成为 Profile。参考 `profiles/echo.js`（最简实现）和 `profiles/claude-code.js`（stream-json 示例）。

## 内置 Profile

| Profile | 需要的 CLI | 说明 |
|---------|-----------|------|
| `claude-code` | `claude` | Claude Code（默认） |
| `cursor` | `agent` | Cursor Agent |
| `agy` | `agy` | Google DeepMind Antigravity |
| `codex` | `codex` | OpenAI Codex |
| `echo` | 无 | 原样回显，调试用 |

## 多轮对话

直接回复 AI 发出的邮件即可继续对话 —— bridge 通过邮件的 `References` 头识别同一会话线程，AI 自动保持上下文。

## 配置文件

- `email-profiles.yaml` — Profile 路由配置（复制自 `email-profiles.example.yaml`）
- `email-acl.yaml` — 发件人访问控制（可选，复制自 `email-acl.example.yaml`）

## 文档

- [部署 Skill（供 AI Agent 使用）](SKILL.md)
- [架构设计](docs/ARCHITECTURE.md)
- [Sender ACL 设计](docs/sender-acl-design.md)
- [Agent 开发指南](AGENTS.md)

## License

MIT
