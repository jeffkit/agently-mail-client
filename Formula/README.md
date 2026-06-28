# Homebrew Formula

This directory contains the Homebrew formula for `agently-mail-client`.

## 发布 Homebrew Tap

### 方式一：使用独立 tap 仓库（推荐）

1. 在 GitHub 创建一个新仓库，命名为 `homebrew-tap`（或 `homebrew-agently`）
2. 将 `agently-mail-client.rb` 复制到该仓库的 `Formula/` 目录
3. 用户安装方式：

```bash
brew tap jeffkit/tap
brew install agently-mail-client
```

### 方式二：直接从本仓库安装（适合开发测试）

```bash
brew install --formula https://raw.githubusercontent.com/jeffkit/agently-mail-client/main/Formula/agently-mail-client.rb
```

## 版本更新流程

每次 `npm publish` 发布新版本后：

1. 获取新 tarball 的 SHA256：
   ```bash
   curl -sL https://registry.npmjs.org/agently-mail-client/-/agently-mail-client-X.Y.Z.tgz | sha256sum
   ```

2. 更新 `agently-mail-client.rb` 中的 `url` 和 `sha256`

3. 推送到 tap 仓库

## 用户使用流程

```bash
# 安装
brew tap jeffkit/tap
brew install agently-mail-client

# 首次授权（需要浏览器）
agently-cli auth login

# 编辑配置
nano $(brew --etc)/agently-mail-client/email-profiles.yaml

# 后台服务启动（随系统开机自启）
brew services start agently-mail-client

# 查看日志
tail -f $(brew --prefix)/var/log/agently-mail-client.log

# 打开管理面板
agently-mail dashboard --config $(brew --etc)/agently-mail-client/email-profiles.yaml
```
