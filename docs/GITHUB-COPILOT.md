# GitHub Copilot Integration Guide

How to configure and run NanoClaw using **GitHub Copilot** as the AI provider instead of Claude / Anthropic.

---

## Overview

This branch (`copilot/port-to-github-copilot`) replaces the Claude agent runner with a GitHub Copilot agent runner that uses the [GitHub Copilot Chat API](https://docs.github.com/en/copilot/using-github-copilot/asking-github-copilot-questions-in-github). The rest of the stack — channels, database, message routing, IPC, scheduling, container isolation — is identical to the upstream project.

### What changes vs upstream

| Component | Upstream (Claude) | This branch (Copilot) |
|---|---|---|
| AI agent runner | `container/agent-runner/` — `@anthropic-ai/claude-agent-sdk` | `container-copilot/agent-runner/` — `openai` npm package |
| Container image | `nanoclaw-agent:latest` (Claude Code inside) | `nanoclaw-copilot-agent:latest` (OpenAI-compatible loop) |
| Credential proxy auth | API key or OAuth token for Anthropic | GitHub OAuth token → auto-refreshed Copilot token |
| Credential env var | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | `GITHUB_TOKEN` |
| Host-side orchestration | unchanged | unchanged |
| Channels, IPC, scheduling | unchanged | unchanged |

Everything else — including the entrypoint script, IPC wire protocol (`OUTPUT_START_MARKER`/`OUTPUT_END_MARKER`), volume mounts, MCP tools, and session semantics — is identical.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) or Docker Engine | WSL2 users: Docker Desktop with WSL integration **or** Docker Engine installed directly in the distro |
| Node.js ≥ 20 | `nvm use` reads `.nvmrc` |
| A GitHub account with an active **GitHub Copilot subscription** | Individual, Teams, or Enterprise |

---

## How the Copilot Agent Works

### vs Claude Agent SDK

The upstream project uses `@anthropic-ai/claude-agent-sdk`, which is a programmatic wrapper around the **Claude Code CLI** — a battle-tested agent with 15+ built-in tools (Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, agent teams, memory management, etc.).

GitHub has no public equivalent. There is no "Copilot Code CLI" or "Copilot Agent SDK":

| Tool | Suitable? |
|---|---|
| `gh copilot` CLI | Interactive only — no pipe / programmatic API |
| GitHub Copilot Coding Agent (Workspace) | No public SDK — browser UI only |
| `@github/copilot-extensions-sdk` | For GitHub App chat extensions — not agent execution |
| GitHub Copilot Chat API | ✅ OpenAI-compatible — what this integration uses |

This integration uses the **`openai` npm package** pointed at `https://api.githubcopilot.com`. An agent loop is hand-rolled with:

- **`bash` tool** — covers all shell, file, and web operations (`ls`, `cat`, `curl`, `git`, etc.)
- **NanoClaw MCP tools** — same as upstream: `send_message`, `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `update_task`, `register_group`
- **Session history** persisted in `/workspace/group/.copilot-sessions/<id>.json` (vs Claude's transcript files)
- **Conversation archiving** when history grows large (same `conversations/` directory)

The `bash` tool is equivalent in power to Claude Code's specialized file tools — it's slightly less ergonomic (you write `bash cat file.txt` vs Claude's dedicated `Read` tool) but covers the same capabilities.

### Credential proxy design

Containers never see the real GitHub token. The host runs a lightweight HTTP proxy on `CREDENTIAL_PROXY_PORT` (default 3001):

```
Container OpenAI client
  └── ANTHROPIC_BASE_URL=http://host.docker.internal:3001
        └── [Credential Proxy — src/credential-proxy.ts]
              ├── reads GITHUB_TOKEN from .env
              ├── exchanges for short-lived Copilot token (expires ~1 hour)
              ├── auto-refreshes before expiry
              └── forwards to https://api.githubcopilot.com
```

The Copilot container reads `ANTHROPIC_BASE_URL` (the same env var the Claude container uses), so `src/container-runner.ts` requires **no changes** — this is key to keeping upstream merges clean.

---

## Authentication Setup

### Step 1 — GitHub OAuth device-code flow

Run the interactive auth helper:

```bash
npm run copilot-auth
```

This walks through the GitHub OAuth device-code flow:

1. Opens `https://github.com/login/device`
2. Prompts you to enter a one-time code
3. Polls until you authorise
4. Exchanges the GitHub token for a Copilot token to verify it works
5. Writes `GITHUB_TOKEN=<token>` to your `.env` file

The token is a standard GitHub personal access token with `copilot` scope. It does **not** expire unless you revoke it in [GitHub settings → Applications](https://github.com/settings/apps). The short-lived Copilot API tokens (≈1 hour) are refreshed automatically by the credential proxy — you never need to re-run `copilot-auth` unless you revoke the token.

### Step 2 — Verify (optional)

```bash
# Should print "github-copilot" if GITHUB_TOKEN is in .env
node -e "
const {readEnvFile} = await import('./dist/env.js');
const {detectAuthMode} = await import('./dist/credential-proxy.js');
console.log(detectAuthMode());
"
```

### Troubleshooting auth

| Error | Fix |
|---|---|
| `Copilot token exchange failed: 401` | Your account doesn't have a Copilot subscription, or the subscription is paused |
| `Copilot token exchange failed: 403` | Copilot access may be restricted by your org policy |
| `Device code request failed` | Check internet connectivity; GitHub may be down |
| Token not refreshing | Restart NanoClaw — the proxy reads `.env` at startup |

---

## Building the Container

```bash
# Default model: gpt-4o
cd container-copilot
./build.sh

# Override model baked into the image
./build.sh latest --model claude-3.5-sonnet
./build.sh latest --model o3-mini
```

Available models depend on your Copilot plan. Common options:

| Model | Plan required |
|---|---|
| `gpt-4o` | Individual / Teams / Enterprise |
| `gpt-4o-mini` | Individual / Teams / Enterprise |
| `claude-3.5-sonnet` | Teams / Enterprise (Copilot Plus) |
| `o3-mini` | Teams / Enterprise (Copilot Plus) |

The model is baked into the image as an ENV default but can be overridden per-build without modifying any source files. To switch models without rebuilding, update `.env`:

```bash
# Not passed by container-runner — you'd need to rebuild the image
# or set it in container-copilot/Dockerfile ARG COPILOT_MODEL=...
```

---

## Configuration

Add to your `.env` (copy from `.env.example`):

```bash
# Required: obtained via "npm run copilot-auth"
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx

# Required: point to the Copilot container image
CONTAINER_IMAGE=nanoclaw-copilot-agent:latest

# Optional: assistant name (trigger word)
ASSISTANT_NAME=Andy
```

That's all. The existing `CREDENTIAL_PROXY_PORT`, `CONTAINER_TIMEOUT`, `IDLE_TIMEOUT`, `MAX_CONCURRENT_CONTAINERS` etc. all work unchanged.

---

## Running

Same as upstream:

```bash
# Development (hot reload)
npm run dev

# Production
npm run build && npm start

# macOS service
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux / WSL systemd service
systemctl --user restart nanoclaw
```

---

## WSL on Windows

WSL2 with Docker is fully supported. The existing `src/container-runtime.ts` auto-detects WSL via `/proc/sys/fs/binfmt_misc/WSLInterop` and binds the credential proxy to `127.0.0.1` — this is the correct address because Docker Desktop's WSL integration routes `host.docker.internal` to the Windows loopback, which in WSL2 maps to `127.0.0.1`.

### WSL setup checklist

1. **Docker Desktop for Windows** with the WSL2 backend enabled, **or** Docker Engine installed directly inside the distro (`sudo apt install docker.io`).
2. If using Docker Engine inside WSL (not Docker Desktop): make sure `host.docker.internal` resolves. Either add `--add-host` manually or rely on `hostGatewayArgs()` in `src/container-runtime.ts` which adds `--add-host=host.docker.internal:host-gateway` on Linux.
3. Install Node.js ≥ 20 inside the WSL distro (e.g. via `nvm`).
4. Clone the repo, run `npm install`, and proceed normally.

```bash
# Inside WSL2 terminal:
git clone <repo> nanoclaw && cd nanoclaw
npm install
npm run copilot-auth        # authenticate once
cd container-copilot && ./build.sh && cd ..
cp .env.example .env
# edit .env: set GITHUB_TOKEN and CONTAINER_IMAGE
npm run dev
```

---

## Branch strategy and upstream sync

This branch is designed to minimise divergence from upstream so that nightly upstream changes can be ported by an automated agent with minimal conflicts.

### Files changed vs upstream

**New files only (zero conflict risk on rebase/merge):**

| File | Purpose |
|---|---|
| `container-copilot/` | Entire Copilot container — Dockerfile, build script, agent runner |
| `src/github-copilot-auth.ts` | OAuth device-code flow + CopilotTokenCache |
| `src/copilot-auth-cli.ts` | `npm run copilot-auth` entry point |
| `docs/GITHUB-COPILOT.md` | This document |

**Existing files with minimal additions:**

| File | Change | Conflict risk |
|---|---|---|
| `src/credential-proxy.ts` | Added `github-copilot` auth mode; existing `api-key` and `oauth` modes unchanged | Low — new code path only |
| `setup/verify.ts` | Check `GITHUB_TOKEN` in addition to Anthropic keys | Low — one line |
| `setup/environment.test.ts` | Updated credential detection test | Low — test-only |
| `.env.example` | Copilot vars documented | Low |
| `package.json` | Added `copilot-auth` script | Low |

**Files intentionally untouched (upstream changes apply cleanly):**

- `container/` — entire original Claude container
- `src/container-runner.ts`
- `src/config.ts`
- `src/index.ts`
- All channel implementations
- All other `src/` files

### When upstream changes arrive

The automated nightly sync agent should:

1. **`container/agent-runner/src/index.ts` changed upstream** → port logic changes to `container-copilot/agent-runner/src/index.ts`, preserving the `runCopilotQuery` call
2. **`container/agent-runner/src/ipc-mcp-stdio.ts` changed upstream** → apply identical changes to `container-copilot/agent-runner/src/ipc-mcp-stdio.ts` (it's a copy)
3. **`container/Dockerfile` changed upstream** → port system-level changes to `container-copilot/Dockerfile`, skipping `@anthropic-ai/claude-code` and preserving `COPILOT_MODEL` ARG
4. **`src/credential-proxy.ts` changed upstream** → merge changes with the `github-copilot` mode additions
5. **Any other file changed upstream** → apply as-is (they're untouched in this branch)

---

## Architecture diagram

```
User message (WhatsApp / Telegram / Slack / Discord / Gmail)
  │
  ▼
[Channel] ──onMessage──► [src/index.ts]
                              │
                         storeMessage()
                              │
                         [SQLite DB]
                              │ (poll every 2 seconds)
                         processGroupMessages()
                              │
                         runAgent() ──► [src/container-runner.ts]
                                              │
                              docker run nanoclaw-copilot-agent:latest
                                              │
                              ┌──────────────▼──────────────┐
                              │  container-copilot/          │
                              │  agent-runner/src/index.ts  │
                              │       │                      │
                              │  runCopilotQuery()           │
                              │       │                      │
                              │  [OpenAI client]             │
                              │  baseURL=ANTHROPIC_BASE_URL  │
                              └──────────────┬──────────────┘
                                             │
                              ┌──────────────▼──────────────┐
                              │  Credential Proxy :3001      │
                              │  src/credential-proxy.ts    │
                              │  github-copilot mode:        │
                              │  - reads GITHUB_TOKEN        │
                              │  - exchanges → Copilot token │
                              │  - injects Authorization     │
                              └──────────────┬──────────────┘
                                             │
                              https://api.githubcopilot.com
                                    /chat/completions
                                             │
                              ┌──────────────▼──────────────┐
                              │  Copilot model response      │
                              │  (tool_calls or final text)  │
                              └──────────────┬──────────────┘
                                             │
                         tool_calls? ────────┤
                              │              │ stop
                         execute tool        │
                         (bash / MCP)    final result
                              │              │
                         loop back      writeOutput()
                                             │
                              OUTPUT_START_MARKER
                              {"result": "…", "newSessionId": "…"}
                              OUTPUT_END_MARKER
                                             │
                         [src/container-runner.ts parses output]
                                             │
                         [channel.sendMessage(jid, text)]
                                             │
                              ▼
                    Reply sent to user
```

---

## Differences from Claude implementation

### Tools available

| Claude Code (upstream) | Copilot agent (this branch) |
|---|---|
| `Bash` | `bash` ✅ |
| `Read`, `Write`, `Edit` | via `bash cat/echo/sed` |
| `Glob`, `Grep` | via `bash find/grep` |
| `WebSearch`, `WebFetch` | via `bash curl` |
| `Task`, `TaskOutput`, `TaskStop` | — (not implemented) |
| `TeamCreate`, `TeamDelete`, `SendMessage` | — (agent teams not implemented) |
| `TodoWrite`, `ToolSearch`, `Skill` | — |
| `NotebookEdit` | — |
| `mcp__nanoclaw__*` | `mcp__nanoclaw__*` ✅ (identical) |

All NanoClaw IPC tools are fully available. File/shell/web tasks work via the `bash` tool. The main gap is agent teams (running parallel sub-agents for complex tasks) — this is a Claude Code-specific feature with no Copilot equivalent.

### Session persistence

| Claude | Copilot |
|---|---|
| Transcript files in `.claude/projects/` | JSON files in `.copilot-sessions/` |
| Session IDs are Claude UUIDs | Session IDs are `crypto.randomUUID()` |
| Compaction hook archives transcripts | Archiving triggers when history > 80 messages |
| Sessions stored in host DB | Sessions stored in host DB (same `sessions` table) |

The session IDs are stored in the same SQLite table and work identically from the host's perspective.

### Conversation memory (CLAUDE.md)

Both implementations load `CLAUDE.md` (and `ASSISTANT.md` as a fallback) from `/workspace/group/` and `/workspace/global/`. Existing memory files work without changes.
