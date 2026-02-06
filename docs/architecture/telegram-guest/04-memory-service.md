# Memory Service (Embeddings + Semantic Search)

## Owner (Suggested Agent)

Agent: `memory-service`

## Purpose

Provide tenant-scoped semantic memory for guest Telegram workspaces:

- index messages (embedding generation + storage)
- retrieve similar past messages for a query

The kernel remains the source of truth for full transcript storage (KV). The memory service is an index.

Contracts source of truth:
- `docs/architecture/telegram-guest/01-contracts.md`

## Why Not Reuse `text-vector-embeddings` As-Is

The existing `text-vector-embeddings` plugin is GitHub-event oriented and assumes:

- GitHub payload shapes (issues/comments/PRs)
- similarity queries that are not naturally tenant-scoped for a "personal assistant" model

For a guest assistant, the #1 failure mode is cross-user memory leakage.

This service must enforce:

- every row includes `workspaceId`
- every search filters by `workspaceId`

## Storage Model

### Canonical Storage (KV)

Kernel stores the full transcript in KV (forever retention).

### Semantic Index (Vector DB)

Vector DB stores:
- `messageId` (primary key)
- `workspaceId` (tenant boundary)
- `createdAt`
- `role`
- `embedding`
- optional `text` (avoid if possible; KV is canonical)

Recommended: do **not** store plaintext in vector DB for v1. Store message IDs only.

## Suggested Schema (Supabase/Postgres + pgvector)

Table: `assistant_messages`

- `id` (text primary key) -> `messageId`
- `workspace_id` (text not null)
- `created_at` (timestamptz not null)
- `role` (text not null) (`user|assistant|tool`)
- `embedding` (vector(1024) not null)
- `metadata` (jsonb null)

Indexes:
- `ivfflat (embedding vector_cosine_ops)`
- btree on `(workspace_id, created_at)`

RLS:
- service role only (the memory service is backend-only)

## Similarity Query

Expose an RPC for tenant-scoped search:

`find_similar_assistant_messages(workspace_id text, query_embedding vector(1024), threshold float8, top_k int)`

Implementation must:
- filter `workspace_id = workspace_id`
- filter on `created_at` if needed (optional)
- order by cosine similarity desc
- limit top_k

## Embedding Provider

Use Voyage or another provider consistent with existing infra.

Key design requirements:
- timeouts and retries (providers rate-limit)
- batch indexing support (optional)
- skip embedding for very short/noisy content (reduce cost, improve quality)

Recommended skip rules (v1):
- skip empty
- skip messages below a minimum length (e.g., < 20 chars)
- optionally skip pure commands (e.g., `/help`) if those exist in guest mode

## API (HTTP)

Must conform to `docs/architecture/telegram-guest/01-contracts.md`:

- `POST /v1/index`
- `POST /v1/search`

Auth:
- kernel-signed requests (RSA) using headers described in contracts.

### Response Shapes

Do not return `{ "ok": true }`.
Use HTTP status codes for success/failure and return structured bodies:

- `202` for accepted indexing
- `200` for search results
- `4xx/5xx` for errors with `{ "error": "...", "code": "..." }`

## Operational Concerns

### Cost + "Forever" Retention

Embedding every message forever can become expensive quickly.

Mitigations (recommended even for v1):
- only embed meaningful user messages (length threshold)
- batch indexing and backoff
- consider "memory compaction": periodically summarize older segments and embed summaries instead of every message (future)

### Backpressure

Kernel should treat memory indexing as best-effort:
- never block Telegram replies on indexing
- time out indexing calls aggressively
- queueing is optional; avoid building a complex queue in v1 unless needed

### Privacy

Prefer not storing plaintext in the vector DB.

If plaintext must be stored for debugging:
- store short snippets only
- ensure it is tenant-scoped and not publicly accessible

## Acceptance Criteria

1. `POST /v1/index` stores embeddings for messages and returns `202`.
2. `POST /v1/search` returns only matches from the requested `workspaceId`.
3. No cross-user leakage under adversarial tests.
4. Handles provider timeouts/rate limits without cascading failures.

