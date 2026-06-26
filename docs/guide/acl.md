# 访问控制

详细介绍见[场景三：白名单 / 黑名单管理](../scenarios/acl-management)。

## 快速配置

```yaml
# email-acl.yaml

admin_senders:
  - me@gmail.com           # 你自己，可以发管理指令

allowed_senders:           # 白名单（不配置 = 所有人可发）
  - "@mycompany.com"

denied_senders:            # 黑名单
  - spam@example.com

instant_reply_senders:     # 这些人的邮件立即回复，不进批处理
  - "@mycompany.com"

deny_action: silent        # silent 或 notify
```

## 管理员指令速查

给你的 Agently Mail 地址发邮件，正文写指令：

```
/allow user@example.com
/deny  user@example.com
/reset user@example.com
/status
```

详见[场景三](../scenarios/acl-management)。
