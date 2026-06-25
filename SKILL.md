---
name: agently-mail-client-setup
description: 帮助用户从零安装并启动 agently-mail-client，让任意 AI CLI（Claude Code、Cursor、agy 等）可以通过邮件被调用和对话。当用户想要配置 Agent 邮件助手、让 AI 自动回复邮件、部署邮件 Bot、安装 agently-mail-client 或 agently-cli，或者说"帮我跑起来这个程序"时，必须使用本 Skill。即便用户只说"我想让 AI 帮我回邮件"，也应触发本 Skill。
---

# agently-mail-client 极速部署 Skill

让 AI（Claude / Cursor / agy 等）通过邮件被调用 —— 用户发邮件提问，AI 自动回复。本 Skill 指导 Agent 完整完成从零安装到收发邮件全链路。

---

## 阶段一：安装并授权 agently-cli

### 步骤 1 — 安装 CLI

```bash
npm install -g @tencent-qqmail/agently-cli
```

验证安装：
```bash
agently-cli --version
```

### 步骤 2 — OAuth 授权（必须交互式处理）

> ⚠️ `agently-cli auth login` 是需要浏览器授权的长命令，必须：
> 1. 以后台 + pty 模式运行（避免阻塞）
> 2. 从 stdout/stderr 提取原始授权 URL
> 3. 向用户展示 URL，提示在浏览器中打开完成授权
> 4. **URL 不能做任何修改**（不要 URL 编码、添加标点、重新拼接 query）
> 5. 失败或超时不要重试，直接将错误反馈给用户

```bash
agently-cli auth login
```

向用户展示时使用以下格式：
```
请点击或复制以下链接在浏览器中完成授权：

<原始授权 URL>
```

用户在浏览器完成授权后，命令会自动退出。

### 步骤 3 — 验证授权

```bash
agently-cli +me
```

成功时向用户确认：
> 邮箱地址 `xxx@agent.qq.com` 已授权成功，可以用它来收发邮件了。

---

## 阶段二：部署 agently-mail-client

### 步骤 4 — 检查 Node.js 环境

```bash
node --version   # 需要 >= 18
```

未安装时：`brew install node`（macOS）或 `sudo apt install nodejs npm`（Linux）

### 步骤 5 — 获取项目

**方式 A：克隆仓库（推荐，方便自定义）**

```bash
git clone https://github.com/jeffkit/agently-mail-client.git
cd agently-mail-client
npm install
```

**方式 B：全局安装**

```bash
npm install -g agently-mail-client
```

### 步骤 6 — 创建配置文件

```bash
cp email-profiles.example.yaml email-profiles.yaml
```

默认配置使用 `claude-code` 作为默认 profile。根据用户已安装的 AI CLI 调整：

```bash
which claude    # Claude Code → 对应 claude-code profile
which agent     # Cursor CLI  → 对应 cursor profile
which agy       # agy CLI     → 对应 agy profile
```

如果用户不确定，先检查哪个 CLI 可用，然后编辑 `email-profiles.yaml` 的 `default:` 字段。

**各 Profile 说明**：

| Profile 名 | 需要的命令 | 推荐场景 |
|-----------|----------|---------|
| `claude-code` | `claude` | 最稳定，推荐首选 |
| `cursor` | `agent` | Cursor 用户 |
| `agy` | `agy` | Google DeepMind |
| `echo` | 无需 AI CLI | 纯调试，原样回显 |

### 步骤 7 — 启动 bridge

```bash
# 开发/测试（每 2 分钟轮询，避免触发接口限频）
POLL_INTERVAL_MS=120000 node bin/cli.js --config email-profiles.yaml

# 生产环境（每 5 分钟轮询）
POLL_INTERVAL_MS=300000 nohup node bin/cli.js --config email-profiles.yaml > bridge.log 2>&1 &
```

启动成功时日志显示：
```
[email-bridge] Loaded 6 profile(s): claude-code, cursor, ...
[email-bridge] Monitoring yourname@agent.qq.com every 30s
[email-bridge] Subject prefix routing: [profile-name], default=claude-code
```

---

## 阶段三：测试验证

### 快速调试（不需要 AI CLI）

给自己的 Agently 邮箱发一封邮件：
- **收件人**：`yourname@agent.qq.com`（步骤 3 获得）
- **主题**：`[echo] 测试`
- **正文**：任意内容

等待一个轮询周期，你会收到内容原样回显的回复邮件。

### 真实 AI 测试

- **收件人**：`yourname@agent.qq.com`
- **主题**：`你好` 或 `[claude] 问个问题`（方括号前缀选择 profile，无前缀走默认）
- **正文**：`1+1 等于多少？`

收到 AI 回复即全链路通畅。

### 多轮对话

直接**回复** AI 的邮件继续对话 —— bridge 通过邮件 `References` 头识别同一线程，AI 自动保持上下文。

---

## 故障排查

**Token 过期**：
```bash
agently-cli auth status   # 查看状态
agently-cli auth login    # 重新授权
```

**邮件未被处理**：
1. 确认 bridge 进程在运行
2. 日志中查找 `[email-bridge] Processing:` 字样
3. 发件人与收件人不能是同一地址（自发邮件会被过滤）

**查看实时日志**：
```bash
tail -f bridge.log
```

---

## 可选：发件人 ACL 配置

只允许特定邮箱发邮件给 Agent（复制并编辑 `email-acl.example.yaml`）：

```bash
cp email-acl.example.yaml email-acl.yaml
```

```yaml
allowed_senders:
  - me@gmail.com
  - "@mycompany.com"
deny_action: silent
```

---

## 完整流程速查

```
1. npm install -g @tencent-qqmail/agently-cli
2. agently-cli auth login        ← 后台运行，提取 URL 给用户在浏览器授权
3. agently-cli +me               ← 获取邮箱地址
4. git clone + npm install       ← 部署项目
5. cp email-profiles.example.yaml email-profiles.yaml
6. POLL_INTERVAL_MS=120000 node bin/cli.js --config email-profiles.yaml
7. 发测试邮件 → 等待 AI 回复 ✅
```

**全程约 5-10 分钟，无需服务器，纯本地运行。**
