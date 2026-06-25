# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

agently-mail-client is a standalone **Email Channel Adapter** implementing the AgentProc P0 protocol. It polls an Agently Mail (QQ Agent) inbox, routes emails to AI CLI profiles by subject prefix, and auto-replies in HTML. Extracted from ilink-hub as the Node.js reference channel for a Universal Agent Gateway.

**Language**: Node.js (>=18), CommonJS. **No build step.**

## Commands

```bash
# Start the bridge (default config: ./email-profiles.yaml, 5-min poll)
npm start
node bin/cli.js
DRY_RUN=1 POLL_INTERVAL_MS=120000 node bin/cli.js --config email-profiles.example.yaml

# Run the test suite (node --test)
npm test
node --test tests/

# Run a single test file
node --test tests/test-sender-acl.js

# Manually verify a profile in isolation (no email server needed)
AGENT_MESSAGE="hello" AGENT_SESSION_ID="" node profiles/echo.js
AGENT_MESSAGE="第二轮" AGENT_SESSION_ID="test-123" AGENT_FROM_USER="user@example.com" node profiles/echo.js
```

Before running `npm start` against a real mailbox, the user must run `agently-cli auth login` once. The `agently-cli` binary is a peer dependency (`@tencent-qqmail/agently-cli`) and is expected on PATH.

## Architecture

The system is a **P0 protocol adapter**: emails come in, environment variables go to a child AI CLI process, its stdout comes back, a reply goes out.

```
AgentlyMailClient (src/agently-mail.js)
   │  wraps `agently-cli` subprocess; handles two-phase send confirmation
   ▼
createEmailBridge (src/index.js)
   │  orchestrates: poll → filter self-sent → global ACL →
   │                admin commands → dispatch → retry sweep
   ▼
ProfileDispatcher (src/dispatcher.js)
   │  • resolveProfile(subject) — matches [tag] prefix or falls back to default
   │  • cleanBody(msg) — strip HTML, quoted replies, Agently footer; truncate
   │  • _sessionId(msg, profile) — thread root via References[0] || In-Reply-To
   │  • _spawnProfile(cfg, msg, sid, ...) — spawnSync with AGENT_* env vars
   │  • session resume + fallback retry on expiry
   ▼
Profile subprocess (profiles/*.js)
   │  receives: AGENT_MESSAGE / AGENT_SESSION_ID / AGENT_SESSION_NAME /
   │            AGENT_FROM_USER / AGENT_STREAMING
   │  emits on stdout: AGENT_SESSION:<uuid> / AGENT_PARTIAL:<json> /
   │                   AGENT_ERROR:<json> / response text
   ▼
Reply via AgentlyMailClient.reply() (Markdown → HTML via marked)
```

### AgentProc P0 protocol

The only contract between the dispatcher and a profile. Any program that reads env vars and writes stdout can be a profile — `profiles/echo.js` is the minimal reference.

- **Input**: 5 env vars (`AGENT_MESSAGE`, `AGENT_SESSION_ID`, `AGENT_SESSION_NAME`, `AGENT_FROM_USER`, `AGENT_STREAMING`)
- **Output**: response text on stdout, optionally prefixed with `AGENT_SESSION:` / `AGENT_PARTIAL:` / `AGENT_ERROR:` lines
- **Per-profile session resume**: if a profile returns a new `AGENT_SESSION:<uuid>`, it's persisted in `~/.agentproc/email-sessions/<sid>.json` and passed back on the next message in the same email thread

### Session persistence (three layers, don't confuse them)

| What | Where | Key |
|------|-------|-----|
| Conversation history (`{role, content}` turns) | `~/.agentproc/sessions/<sid>.jsonl` | Managed by `agentproc` lib — agentproc's standard path |
| CLI-internal session id (e.g. `claude --resume <id>`) | `~/.agentproc/email-sessions/<sid>.json` | Sidecar JSON, one per (email thread × profile) |
| Pending/retry queue, denied log, dynamic ACL, poll cursor | `~/.agently-mail-client/` | Bridge's own state |

The session id is computed from the **email thread root** (References[0] → In-Reply-To → own Message-ID) combined with the profile name, so all replies in one thread share conversation context.

### Profile families in `profiles/`

- **stream-json** (`claude-code`, `cursor`, `codebuddy`) — share `_stream_json.js`, all emit the same `--output-format stream-json` event schema
- **JSONL** (`codex`) — parses `thread.started` / `item.completed` events independently
- **plain text** (`agy`) — extracts conversation id from a log file
- **echo** — debug profile, no AI CLI needed

All implement session resume + a fallback retry that starts a fresh session if the saved one expired.

## Config files (runtime, gitignored)

- `email-profiles.yaml` — profile routing (copy from `email-profiles.example.yaml`). `args` paths resolve relative to the yaml file's directory.
- `email-acl.yaml` — sender ACL + admin senders + inspection report config (copy from `email-acl.example.yaml`). Optional; absence means open access.

ACL merging (in `src/acl-config.js`): `acl-dynamic.json` (runtime, admin-controlled) is layered on top of the static yaml. Dynamic `allowed` evicts from merged `denied`; admin_senders / deny_action / report settings come only from the static file.

Admin commands (`/allow`, `/deny`, `/reset`, `/status`) are sent in the email body from an `admin_senders` address; handled by `src/admin-handler.js`, which bypasses the normal dispatch path.

## Editing notes

- After touching `dispatcher.js`, sanity-check `cleanBody` (HTML/quote/footer stripping) and `resolveProfile` (subject prefix matching) — these are the most error-prone.
- New profiles should mirror `profiles/echo.js` for the P0 contract; stream-json profiles can reuse `profiles/_stream_json.js`.
- `marked` is the only non-trivial dependency — used by `convertMarkdownToHtml` for HTML reply formatting. Replies are always HTML; `bodyFormat: 'html'` is passed to `client.reply()`.
- The retry sweep runs on every poll interval at a half-interval offset (avoids bursting API calls alongside the main poll). Failed messages stay in the pending store across restarts.
- `agently-cli +read` marks messages as read server-side, so `PendingStore.add()` is called *before* `read()` to avoid losing mails that fail during dispatch.
