# agently-mail-client

[![CI](https://github.com/jeffkit/agently-mail-client/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffkit/agently-mail-client/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/agently-mail-client.svg)](https://www.npmjs.com/package/agently-mail-client)
[![license](https://img.shields.io/npm/l/agently-mail-client.svg)](https://github.com/jeffkit/agently-mail-client/blob/main/LICENSE)

An **Email Channel Adapter** implementing the [AgentProc](https://www.npmjs.com/package/agentproc) P0 protocol. It polls an Agently Mail (QQ Agent) inbox, routes emails to AI CLI profiles by subject prefix, and auto-replies in HTML.

## Install

```bash
npm install -g agently-mail-client
# Peer dependency — the agently-cli binary must be on PATH
npm install -g @tencent-qqmail/agently-cli
agently-cli auth login
```

## Usage

```bash
# Start the bridge (default config: ./email-profiles.yaml, 5-min poll)
agently-mail --config email-profiles.yaml

# Dry-run, 30s poll
DRY_RUN=1 POLL_INTERVAL_MS=30000 agently-mail --config email-profiles.example.yaml
```

Send an email to your Agently Mail address with a subject like `[claude] hello` — the matching profile handles the body and replies. See `email-profiles.example.yaml` for profile routing config and `email-acl.example.yaml` for sender ACL.

## How it works

```
Agently Mail inbox
   ↓ poll (agently-cli)
ProfileDispatcher  →  resolveProfile(subject)  →  [tag] prefix → profile
   ↓ cleanBody (strip HTML / quoted lines / footer)
spawn profile (AGENT_MESSAGE / AGENT_SESSION_ID / ...) → stdout
   ↓ convertMarkdownToHtml()
reply (HTML)
```

Any program that reads env vars and writes stdout can be a profile. See `profiles/echo.js` for the minimal reference and `profiles/claude-code.js` for a stream-json example.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Sender ACL design](docs/sender-acl-design.md)
- [Agent guide](AGENTS.md)

## License

MIT
