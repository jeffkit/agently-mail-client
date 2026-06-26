# 场景三：白名单 / 黑名单管理

> 适合：需要控制哪些人可以触发 AI 回复，防止滥用或骚扰。

## 访问控制层级

```
来信
 ├─ 是否是自己发的？→ 过滤（防回环）
 ├─ 在 denied_senders？→ 拒绝
 ├─ allowed_senders 非空且不在其中？→ 拒绝
 ├─ 是 admin_senders？→ 执行管理指令
 └─ 通过 → 即时回复 or 进批处理队列
```

## 静态配置（`email-acl.yaml`）

```yaml
# 黑名单：直接拒绝，优先级最高
denied_senders:
  - spam@example.com
  - "@blocked-domain.com"

# 白名单：只接受这些来信（不配置 = 接受所有人）
allowed_senders:
  - "@mycompany.com"
  - trusted@gmail.com

# 拒绝时的行为
deny_action: silent   # silent = 静默丢弃；notify = 发拒绝通知

# 自定义拒绝通知内容（deny_action: notify 时生效）
deny_message: "感谢来信，您暂无权限使用此服务，请联系管理员。"
```

## 动态管理（管理员邮件指令）

配置 `admin_senders` 后，你可以直接发邮件下指令，无需修改配置文件：

```yaml
admin_senders:
  - me@gmail.com
```

### 可用指令

给你的 Agently Mail 地址发邮件，正文写指令（每条单独一行）：

| 指令 | 效果 |
|------|------|
| `/allow user@example.com` | 动态加入白名单 |
| `/allow @example.com` | 放行整个域名 |
| `/deny user@example.com` | 动态加入黑名单 |
| `/deny @example.com` | 封禁整个域名 |
| `/reset user@example.com` | 从动态名单移除，恢复静态配置 |
| `/status` | 查看当前 ACL 状态快照 |

### 示例

发一封邮件，正文：

```
/allow partner@newcompany.com
/deny spam@harasser.com
/status
```

Agent 执行后回复：

```
已处理 3 条指令：

✅ /allow partner@newcompany.com
✅ /deny spam@harasser.com
📋 当前 ACL 状态：
  静态白名单：@mycompany.com
  动态白名单：partner@newcompany.com
  动态黑名单：spam@harasser.com
  开放访问：否
  拒绝动作：silent
```

## 优先级规则

动态指令与静态配置的合并规则：

1. **黑名单优先于白名单**（被封禁的人即使在白名单里也会被拒绝）
2. **动态放行不能覆盖静态黑名单**（静态配置是权威来源）
3. `/allow` 会同时从动态黑名单中移除该地址
4. `/reset` 只影响动态部分，静态配置不变

## 巡检报告

系统会定期把被拒绝的邮件汇总发给管理员，方便你决定是否要放行：

```yaml
report:
  enabled: true
  interval_hours: 24      # 每 24 小时检查一次
  min_denied_count: 1     # 至少有 1 封被拒才发报告
```

报告邮件直接附带可执行的 `/allow` / `/deny` 指令示例，回复即可操作。

## 匹配语法

所有名单（`allowed_senders`、`denied_senders`、`instant_reply_senders`）支持三种格式：

| 格式 | 示例 | 匹配范围 |
|------|------|---------|
| 精确地址 | `user@example.com` | 仅该邮箱 |
| 域名 | `@example.com` | 该域所有邮箱 |
| 子域通配 | `@*.example.com` | 所有子域名的邮箱 |

::: warning 管理员安全提示
`admin_senders` 不要配置公共邮件域（如 `@gmail.com`），否则任何 Gmail 用户都能执行管理指令。建议使用企业域名或单个可信邮箱地址。
:::
