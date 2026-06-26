# Profile 路由

## 主题前缀路由

发邮件时，在主题前加 `[profile名]` 前缀，邮件会路由到对应的 AI Agent：

```
Subject: [claude] 帮我看这段代码     → claude-code Profile
Subject: [cursor] 这个报错怎么解决   → cursor Profile
Subject: 普通问题                    → 默认 Profile（无前缀）
```

## 配置文件

`email-profiles.yaml` 控制路由规则：

```yaml
default: claude-code   # 无前缀时使用的 Profile

profiles:
  claude-code:
    command: node
    args: [./profiles/claude-code.js]
    description: Claude Code AI 助手
    trigger: claude        # 主题前缀 [claude] 触发此 Profile

  echo:
    command: node
    args: [./profiles/echo.js]
    description: 原样回显（调试用）
    trigger: echo
```

## 自定义 Profile

任何可执行文件都可以是 Profile，只需遵循 [P0 协议](../reference/protocol)：读 5 个环境变量，写 stdout。

最小示例（`my-profile.js`）：

```js
#!/usr/bin/env node
const msg = process.env.AGENT_MESSAGE;
console.log(`AGENT_SESSION:${require('crypto').randomUUID()}`);
console.log(`收到消息：${msg}`);
```

在 `email-profiles.yaml` 中注册：

```yaml
profiles:
  my-profile:
    command: node
    args: [./my-profile.js]
    trigger: my
```

发 `Subject: [my] 测试` 即可触发。
