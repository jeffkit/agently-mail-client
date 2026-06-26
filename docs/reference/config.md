# 完整配置参考

## email-profiles.yaml

控制邮件路由到哪个 AI Profile。

```yaml
# 默认 Profile（无主题前缀时使用）
default: claude-code

profiles:
  <profile-name>:
    command: <可执行文件>      # 必填
    args: [<参数列表>]         # 可选
    description: <描述>        # 可选，显示在日志中
    trigger: <主题前缀>        # 可选，默认与 profile-name 相同
```

### 内置 Profile 列表

| Profile | Trigger | 说明 |
|---------|---------|------|
| `claude-code` | `claude` | Claude Code CLI |
| `cursor` | `cursor` | Cursor Agent CLI |
| `codebuddy` | `codebuddy` | CodeBuddy CLI（腾讯云） |
| `codex` | `codex` | OpenAI Codex CLI |
| `agy` | `agy` | Google DeepMind Agy CLI |
| `echo` | `echo` | 原样回显（调试用） |

## email-acl.yaml

控制发件人访问权限与批处理行为。

```yaml
# ── 发件人控制 ──────────────────────────────────

# 管理员：可以通过邮件发送 /allow /deny /status 等指令
admin_senders:
  - me@example.com

# 白名单：只接受这些人的来信（不配置 = 接受所有人）
allowed_senders:
  - "@mycompany.com"
  - trusted@gmail.com

# 黑名单：拒绝这些人的来信，优先级高于白名单
denied_senders:
  - spam@example.com
  - "@blocked.com"

# 即时回复名单：这些人的来信立即回复，不进批处理队列
# 语义独立于 allowed_senders
instant_reply_senders:
  - "@mycompany.com"
  - me@gmail.com

# 被拒绝时的行为
# silent: 静默丢弃（默认，不泄露 Agent 存在）
# notify: 发送礼貌的拒绝通知
deny_action: silent

# 自定义拒绝通知正文（deny_action: notify 时生效）
deny_message: "感谢来信，您暂无权限使用此服务。"

# ── Per-Profile 访问控制（可选）────────────────
# 在全局 ACL 通过后，再对特定 Profile 做额外限制
profile_acl:
  echo:
    allowed_senders:
      - me@gmail.com   # echo Profile 只有自己能用

# ── 巡检报告 ────────────────────────────────────
report:
  enabled: true
  interval_hours: 24     # 报告发送间隔（小时）
  min_denied_count: 1    # 至少有 N 封被拒才触发报告

# ── 批处理模式（可选）──────────────────────────
batch_mode:
  enabled: true
  collect_interval_hours: 2   # 摘要邮件发送间隔（小时，默认 2）
  ai_profile: claude-code     # 解读主人指令使用的 Profile（默认 = default）
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PROFILES_CONFIG` | `./email-profiles.yaml` | profiles 配置路径 |
| `POLL_INTERVAL_MS` | `300000` | 轮询间隔（毫秒） |
| `DRY_RUN` | `0` | 设为 `1` 则不实际发送邮件 |

## 命令行选项

```bash
agently-mail [options]

  --config <path>    profiles 配置路径
  --interval <ms>    轮询间隔（毫秒）
  --dry-run          不实际发送邮件
  -h, --help         显示帮助

agently-mail dashboard [options]

  --port <port>      Dashboard 监听端口（默认 3030）
  --host <host>      监听地址（默认 127.0.0.1）
```

## 地址匹配语法

适用于所有发件人列表字段：

| 格式 | 示例 | 匹配 |
|------|------|------|
| 精确地址 | `user@example.com` | 仅该地址（大小写不敏感） |
| 域名 | `@example.com` | 该域所有地址 |
| 子域通配 | `@*.example.com` | 所有子域的地址 |
