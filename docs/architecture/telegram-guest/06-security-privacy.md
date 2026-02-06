# Security & Privacy (Guest Tier)

## Owner (Suggested Agent)

Agent: `security-privacy`

## Threat Model (What Can Go Wrong)

1. **Cross-user data leakage**
   - most severe: memory search returns another user's content
   - KV reads return wrong tenant transcript

2. **Unauthorized plugin/memory invocation**
   - public internet calls internal services to read/write user memory/state

3. **Replay attacks**
   - attacker replays a signed request to mutate state repeatedly

4. **Abuse / cost runaway**
   - user spams bot, generating large LLM/embedding costs

5. **PII storage proliferation**
   - plaintext stored redundantly across KV + vector DB + logs

## Tenant Boundary (Non-Negotiable)

The tenant boundary is `workspaceId`.

Rules:
- Every KV key must include `workspaceId` (or be a direct mapping to it).
- Every vector DB row must include `workspaceId`.
- Every vector DB search must filter by `workspaceId`.
- Plugins must treat `workspaceId` as the only scope and must not accept cross-tenant reads.

## Service Auth (Kernel-Signed Requests)

Memory service and Telegram plugins are internal.

Requirement:
- Verify kernel signatures (see `docs/architecture/telegram-guest/01-contracts.md`).

Reject:
- missing headers
- expired requests
- invalid signatures

## Replay Protection

Minimum viable:
- short `expiresAt` windows (e.g., 2 minutes)
- requestId included in body and logged

Preferred:
- store `(requestId, workspaceId)` in KV with short TTL to reject duplicates (idempotency cache)

## Rate Limiting / Quotas

Even with "forever retention", we need abuse controls.

Recommended:
- per-workspace token bucket in KV:
  - Telegram inbound messages per minute
  - LLM calls per minute
  - memory indexing per minute
  - plugin invocations per minute

Behavior:
- on limit exceeded: respond with a short message and do not invoke LLM/plugins.

## Logging

Do not log full message bodies at info level.

Guidelines:
- log requestIds, workspaceId, sizes, timings
- message text only at debug level, and ideally truncated

## Data Storage: "Forever" With Escape Hatches

"Forever" retention is a product default, but engineering should keep the following possible:

- export: user requests a transcript dump
- delete: user requests account deletion ("forget me")

Implementation implications:
- keep KV keys organized by workspaceId to enable prefix deletion
- avoid duplicating plaintext into vector DB where possible
- maintain a map of all stores that hold user data

## PII Minimization

Preferred:
- KV stores plaintext transcript (canonical)
- vector DB stores embeddings + messageId references only

If vector DB stores text snippets:
- store minimal snippets
- ensure tenant scoping and access controls are airtight

## Telegram-Specific

- Only accept Telegram webhooks with secret-token verification (already supported).
- Enforce DM-only in guest mode initially to avoid group privacy ambiguity.

## Acceptance Criteria

1. Memory service cannot return results across workspaces.
2. Plugins/memory reject unsigned or expired requests.
3. Basic per-workspace rate limits exist to prevent runaway costs.

