# KV Storage (Guest Data Plane)

## Owner (Suggested Agent)

Agent: `kv-storage`

## Goals

- Durable guest chat transcript (forever retention).
- Stateless runtime correctness (serverless assumption).
- Simple, low-latency access to recent transcript.
- Strict tenant boundary: everything scoped to `workspaceId`.

Contracts source of truth:
- `docs/architecture/telegram-guest/01-contracts.md`

## Keyspace

Prefix everything:

```
["ubiquityos", "assistant", "v1", ...]
```

Do not reuse GitHub-oriented KV prefixes.

## Message Append Strategy

Two access patterns must be supported efficiently:

1. Append-only writes by messageId.
2. Read "last N messages" quickly.

Recommended:

- Store each message at:
  - `... "message", workspaceId, messageId`
- Maintain a "recent index" document per workspace:
  - `... "recent", workspaceId`

### Concurrency / Atomicity

When appending a message:

1. `set(messageKey, message)`
2. update recent index to include messageId (cap to max size)

If KV supports atomic operations:
- use `atomic()` to ensure index update doesn't lose concurrent messages.

If atomic is not available:
- allow eventual consistency in the recent index; fall back to listing by prefix when needed.

## MessageId Generation

Requirements:
- uniqueness
- stable ordering for "recent transcript" reads

Preferred:
- ULID (time sortable, compact)

Fallback (acceptable for MVP):
- `${Date.now()}:${crypto.randomUUID()}`

If using timestamp-prefix IDs, sort lexicographically by timestamp.

## Transcript Read Strategy

For a prompt context, we typically want the last 10-30 messages.

Algorithm:

1. read recent index for workspace
2. fetch messages by ids
3. order by messageId (time-sortable) or by createdAt
4. apply maxChars cap when building prompt context

Failover:
- if recent index is missing/corrupt, list by prefix `... "message", workspaceId` with a limit.

## Forever Retention (Operational Notes)

"Forever" is a product decision. Engineering must still plan for:

- storage growth (unbounded message count)
- data deletion/export requests (even if not used day 1)

At minimum:
- ensure keys include `workspaceId` so deletion can be implemented later via prefix scans
- avoid duplicating PII into multiple stores unless necessary (see memory service doc)

## Suggested Helper Module

Create a dedicated storage wrapper with a narrow API:

- `ensureWorkspace(workspaceId, telegramUserId)`
- `appendMessage(workspaceId, message)`
- `getRecentMessages(workspaceId, limit)`
- `getMessagesById(workspaceId, messageIds[])`

Keep it separate from GitHub KV modules to avoid cross-contamination.

## Tests

Unit tests:
- message append updates index correctly
- concurrent appends do not drop messages (best-effort if KV supports atomic)
- transcript read returns in chronological order

Security test:
- attempting to read messages with wrong workspaceId must return nothing / throw

