# Telegram-Native Plugins (Guest Tier)

## Owner (Suggested Agent)

Agent: `telegram-plugins`

## Goal

Create a plugin ecosystem that works for guest Telegram users without GitHub dependencies.

Constraints:
- HTTP plugins only for guest tier (no GitHub Actions dispatch).
- Kernel owns Telegram messaging (plugins return content; kernel sends it).
- Strict `workspaceId` scoping for any plugin state.

Contracts source of truth:
- `docs/architecture/telegram-guest/01-contracts.md`

## Plugin Runtime Model

### What A Guest Plugin Can Assume

- It is invoked by the kernel.
- It receives:
  - `workspaceId`, `conversationId`
  - a command name + parameters
  - recent transcript excerpt
  - optional memory matches
  - Telegram metadata (userId/chatId)

### What A Guest Plugin Must NOT Assume

- No GitHub installation token.
- No Octokit.
- No GitHub issue/comment payloads.
- No ability to DM the user directly via Telegram bot token (kernel keeps bot token).

## Plugin Manifest

Each plugin exposes `GET /manifest.json` (see contracts).

The kernel uses manifests to:
- show `/help` output
- build router prompt command list
- validate router-selected commands

### Command Namespacing

Use stable namespaced command IDs:

- `note.add`, `note.list`, `note.search`
- `task.add`, `task.list`, `task.complete`

Avoid Telegram slash command coupling in plugin names; the kernel can map slash commands to these.

## Dispatch

Kernel calls:
- `POST /v1/dispatch`

Plugins respond with:
- one or more `messages` to send back to user

Keep responses concise; Telegram has a 4096 char message limit.

## State Storage

Preferred v1 pattern:
- plugins are stateless
- kernel provides the durable stores (KV and memory service)
- plugins request state changes via response "writes" (reserved for future), or use dedicated kernel APIs (future)

If a v1 plugin needs its own state:
- it must store state in a durable store scoped by `workspaceId`
- do not use in-memory caches for correctness

## Security

Plugins must verify kernel-signed requests (see contracts).

Minimum checks:
- verify signature with `KERNEL_PUBLIC_KEY`
- reject expired requests
- validate `workspaceId` format

## Suggested Starter Plugins

These are minimal, high-signal plugins for a guest assistant MVP:

1. Notes
   - `note.add { text }`
   - `note.list { limit }`
   - `note.search { query }`

2. Tasks
   - `task.add { text, dueAt? }`
   - `task.list { status? }`
   - `task.complete { taskId }`

3. Summarize
   - `chat.summarize { window?: "last_20" | "last_100" }`

Notes:
- Notes/Tasks require storage decisions. Prefer kernel-owned KV modules or a dedicated plugin store table keyed by workspaceId.
- Summarize can be pure LLM and store summary back into KV as an assistant message (optional).

## Hosting + Rate Limit Caveat

It is fine to host plugin code on GitHub and deploy from GitHub Actions.

The guest runtime should avoid GitHub API calls:
- do not dispatch guest plugins via GitHub Actions workflows
- do not fetch manifests/config from GitHub on-demand

If guest runtime depends on GitHub at runtime, all guest users share:
- GitHub API rate limits per installation/token
- GitHub Actions queue/concurrency limits

That becomes a scaling bottleneck quickly.

## Acceptance Criteria

1. A plugin can be deployed as an HTTP service, exposing `GET /manifest.json` and `POST /v1/dispatch`.
2. Kernel can invoke it for a guest workspace and return results to Telegram.
3. Plugin verifies kernel signatures and rejects invalid/expired requests.

