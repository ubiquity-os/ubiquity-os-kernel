# Kernel: Guest Telegram Ingress

## Owner (Suggested Agent)

Agent: `kernel-guest-ingress`

## Goal

Enable Telegram DM users without GitHub linkage to use the system as a personal assistant:

- persist chat transcript in KV
- retrieve memory snippets from memory service
- route via LLM to either reply directly or invoke Telegram-native plugins
- keep existing GitHub-linked Telegram behavior intact

This work must conform to:

- `docs/architecture/telegram-guest/01-contracts.md`

## Non-Goals

- Do not modify GitHub-linked flows beyond what is required to keep them working.
- Do not introduce new environment variables without explicit approval.
- Do not store guest chat history in GitHub issues/comments.

## Proposed Code Organization

Create a guest assistant module tree to avoid contaminating GitHub-first utilities:

- `src/assistant/guest/`:
  - KV storage wrapper (workspace + messages)
  - memory client
  - plugin client
  - router prompt builder for guest mode

Telegram handler integration points:

- `src/telegram/handler.ts`:
  - Detect DM + not linked identity -> route to guest assistant pipeline.
  - Linked identity -> keep current GitHub-shaped pipeline.

## Guest DM Pipeline (Step-by-Step)

### 1) Identify Workspace

Input: Telegram update -> `telegramUserId`.

Rules:
- DM-only MVP: if chat is not private, respond with a short message telling user to DM the bot.
- `workspaceId = telegram:user:<telegramUserId>`

Ensure workspace exists:
- read KV workspace record
- if missing, create record (idempotent)

### 2) Append Inbound Message

- Create `messageId` (time-sortable preferred).
- Append message record to KV (per contract).
- Update the recent index list.

### 3) Memory Retrieval

Call memory service:
- `POST /v1/search` with `{ workspaceId, query.text = userText }`
- If memory service is down or times out, proceed without memory (fail open but log).

Fetch any returned message texts from KV by `messageId` to build snippets.

### 4) Build Router Prompt + Input

Inputs:
- recent transcript (e.g., last 20 messages, capped by char count)
- memory snippets (topK, capped)
- available plugin commands (from guest plugin catalog)

Router must be prompt-driven; no keyword triggers.

The router output must conform to `01-contracts.md` "Router Output Contract".

### 5) Execute Decision

- `action=reply`: send Telegram message; append assistant message to KV; index it (async best-effort).
- `action=command`: dispatch to plugin; send returned messages; append to KV; index any assistant text (async).
- `action=help`: send help (available plugin commands); do not alter memory.
- `action=ignore`: no-op.

### 6) Indexing (Async Best-Effort)

Call memory service:
- `POST /v1/index` with inbound message
- optionally also index assistant replies

If indexing fails:
- log
- do not impact user experience (still reply)

## Guest Plugin Catalog (Kernel-Side)

MVP approach (no new env vars):
- hardcode a small allowlist of plugin base URLs in code (temporary)
- kernel fetches `GET /manifest.json` from each plugin URL and caches in KV (optional)

Later:
- allow updating guest plugin list via a KV-admin command/endpoint (still no new env vars required).

Important:
- Do not fetch plugin manifests from GitHub.
- Guest plugins are HTTP services; do not use GitHub Actions dispatch for guest commands.

## Acceptance Criteria

1. DM from an unlinked Telegram user produces an assistant reply without any GitHub setup.
2. Messages persist in KV and survive kernel restarts (serverless stateless assumption).
3. Memory search is scoped by `workspaceId` (no cross-user leaks).
4. At least one Telegram-native plugin can be invoked via router decision:
   - kernel dispatch -> plugin -> kernel sends message back to Telegram
5. Linked-user Telegram behavior remains unchanged.

## Testing

- Add Jest tests for:
  - workspaceId derivation
  - KV message append + recent index update
  - router decision parsing
  - plugin dispatch request shape
- Add a small local harness (optional) that:
  - simulates Telegram updates into `handleTelegramWebhook`
  - asserts KV writes and expected responses

## Risks / Edge Cases

- Telegram message ordering: use message timestamps / IDs; KV append should preserve ordering for transcript.
- Telegram rate limits: avoid sending multiple messages in rapid bursts; collapse plugin outputs when needed.
- Long message handling: chunk replies as needed (Telegram has a 4096 char limit).

