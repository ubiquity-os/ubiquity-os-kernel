# Overview: Telegram-Only Guest Mode

## Summary

We want a frictionless Telegram-only "personal assistant" tier where users **do not need GitHub accounts** but can still:

- Chat with the bot in Telegram DMs.
- Have the system remember their chat history (forever retention).
- Use **Telegram-native plugins** (new plugin set, not GitHub-centric marketplace plugins).

Linked GitHub users keep the existing GitHub-first workflow (repo config, GitHub events, Actions plugins, etc.).

## Why This Is A Separate Architecture Path

Today the Telegram handler creates a GitHub-shaped event context and pushes everything through:

- GitHub config loading (`.ubiquity-os` repo)
- GitHub installation auth (Octokit tokens)
- GitHub event payload shapes (`issue_comment.created`, etc.)

Guest mode must not depend on those assumptions. It needs a parallel data plane:

- Durable per-user storage (KV)
- Tenant-scoped semantic memory (vector DB)
- Telegram-native plugin dispatch

## Planes

### Control Plane (GitHub)

- Code hosting and CI.
- Deployment source of truth.
- Linked user configuration (`.ubiquity-os` repo).
- GitHub automation plugins (Actions, Octokit).

### Guest Data Plane (Non-GitHub)

- KV-backed chat persistence and assistant state.
- Vector memory service with strict tenant isolation.
- Telegram-native HTTP plugins.

## MVP Scope (DM Only)

To ship fast and avoid permission complexity:

- **DM-only** guest assistant.
- No group chats, no topics, no shared "workspaces" in Telegram.
- The "workspace" is the Telegram user.

Future: add optional workspaces/topics after the DM MVP is stable.

## Conceptual Model

- `workspaceId`: the unit of tenancy (one per Telegram user in the MVP)
- `conversationId`: a unit of conversational context (for MVP can equal `workspaceId`)
- `messageId`: unique ID for each stored inbound/outbound message

```
Telegram user (DM)
  -> workspaceId = telegram:user:<userId>
      -> message log in KV
      -> embeddings in vector DB scoped to workspaceId
      -> plugin state in KV scoped to workspaceId (if needed)
```

## High-Level Runtime Flow (Guest DM)

1. Telegram message arrives at kernel `/telegram`.
2. Kernel resolves `workspaceId` from Telegram user ID.
3. Kernel appends inbound message to KV.
4. Kernel requests semantic matches from memory service (vector DB), scoped by `workspaceId`.
5. Kernel builds prompt context: recent transcript + memory snippets + plugin catalog.
6. Router/LLM decides: reply vs invoke plugin.
7. Kernel sends Telegram reply.
8. Kernel appends outbound message to KV.
9. Kernel indexes messages into memory service (async best-effort).

## GitHub Rate Limits Caveat (Important)

Hosting plugin *code* on GitHub does not create per-user GitHub API contention by itself.

You only create shared GitHub rate-limit / queue bottlenecks if the guest runtime depends on GitHub at runtime, e.g.:

- dispatching guest plugins as GitHub Actions workflows
- fetching manifests/config from GitHub per request
- storing guest conversations as GitHub Issues/Comments

Recommendation: guest plugins should run as **HTTP services**, and guest configuration should live in code or KV (not GitHub) for the guest hot path.

## Milestones

1. **Guest DM chat + KV transcript** (no memory, no plugins).
2. **Memory service** (index + search with strict `workspaceId` scoping).
3. **Telegram plugin framework** (manifest + dispatch + signatures) + 2-3 starter plugins.
4. Hardening: quotas, abuse controls, observability, optional user delete/export despite "forever" default.

## How Work Is Parallelized

Parallelization only works if contracts are frozen early. See:

- `docs/architecture/telegram-guest/01-contracts.md`
- `docs/architecture/telegram-guest/09-orchestration-worktrees.md`

