# agently-mail-client

[![CI](https://github.com/jeffkit/agently-mail-client/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffkit/agently-mail-client/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/agently-mail-client.svg)](https://www.npmjs.com/package/agently-mail-client)
[![license](https://img.shields.io/npm/l/agently-mail-client.svg)](LICENSE)

把邮箱变成 AI Agent 的通信通道。收到邮件 → AI 处理 → 自动回复，支持多 Agent 路由、批量处理、发件人访问控制。

**📖 完整文档：[jeffkit.github.io/agently-mail-client](https://jeffkit.github.io/agently-mail-client/)**

---

## 极速上手

**方式一：让 AI Agent 帮你部署（最简单）**

把这句话发给你的 AI Agent，全程自动完成：

```
请阅读 https://raw.githubusercontent.com/jeffkit/agently-mail-client/main/SKILL.md 并按步骤帮我完整部署 agently-mail-client
```

**方式二：手动 3 步安装**

```bash
# 1. 安装
npm install -g agently-mail-client @tencent-qqmail/agently-cli

# 2. 登录 Agently Mail
agently-cli auth login

# 3. 初始化配置并启动
agently-mail init
agently-mail
```

启动后给你的 Agently Mail 地址发一封邮件，AI 会自动回复。

---

## 管理面板

```bash
agently-mail dashboard
# 浏览器自动打开 http://localhost:3030
```

实时查看黑白名单、批处理队列、处理历史、配置状态。

---

## 主要特性

| 特性 | 说明 |
|------|------|
| 多 Agent 路由 | 主题加 `[claude]` / `[cursor]` 前缀，发给对应 AI |
| 批处理模式 | 陌生来信先汇总，主人用自然语言决定怎么处理 |
| 发件人 ACL | 白名单、黑名单、管理员指令（`/allow` `/deny` `/status`） |
| 会话记忆 | 同一邮件线程自动续接对话上下文 |
| 即时回复名单 | 信任域始终即时回复，不受批处理影响 |

## 许可

MIT
