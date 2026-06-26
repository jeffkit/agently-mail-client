# 快速开始

## 方式一：零安装试用（npx）

不想全局安装？一行命令直接试跑：

```bash
# 登录 Agently Mail（只需一次）
npx @tencent-qqmail/agently-cli auth login

# 用示例配置试跑（DRY_RUN=1 不会真正发邮件）
DRY_RUN=1 npx agently-mail-client
```

---

## 方式二：全局安装（推荐正式使用）

### 1. 安装

```bash
npm install -g agently-mail-client @tencent-qqmail/agently-cli
```

### 2. 登录 Agently Mail

```bash
agently-cli auth login
```

按提示完成 QQ 邮箱授权。授权信息保存在本地，之后无需重复登录。

### 3. 初始化配置

```bash
# 在你想存放配置的目录下执行
agently-mail init
```

这会在当前目录生成：
- `email-profiles.yaml` — AI Profile 路由配置
- `email-acl.yaml` — 发件人访问控制配置

::: tip 手动复制
如果没有 `init` 命令，也可以手动复制示例：
```bash
cp $(npm root -g)/agently-mail-client/email-profiles.example.yaml ./email-profiles.yaml
cp $(npm root -g)/agently-mail-client/email-acl.example.yaml ./email-acl.yaml
```
:::

### 4. 启动

```bash
agently-mail
```

看到如下输出说明运行正常：

```
[email-bridge] Loaded 1 profile(s): claude-code
[email-bridge] Monitoring me@example.com every 300s
```

### 5. 发第一封邮件

给你的 Agently Mail 地址发一封邮件：

```
Subject: 你好
Body:    请介绍一下你自己
```

约 10–30 秒后（取决于 AI 响应速度），你会收到 HTML 格式的 AI 回复。

---

## 管理面板

```bash
agently-mail dashboard
```

浏览器自动打开 `http://localhost:3030`，可查看黑白名单、批处理队列、处理历史、配置状态。

---

## 下一步

- [配置多个 Profile](./profiles) — 按主题前缀路由到不同 AI
- [设置访问控制](./acl) — 白名单 / 黑名单 / 管理员指令
- [场景：邮箱即聊天窗口](../scenarios/chat-with-agent)
- [场景：批量处理来信](../scenarios/batch-mode)
