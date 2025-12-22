# `message-embeddings` -- Long-term semantic memory for kernel

Status: Draft  
Last updated: 2025-12-19

## Summary

Capture embeddings for every inbound GitHub message handled by the kernel (comments, issue bodies, and other specs) and store them permanently in Supabase (pgvector). For now this reuses the existing `@ubiquity-os/text-vector-embeddings` plugin schema and Voyage AI model (`voyage-large-2-instruct`, 1024 dims), with the kernel querying Supabase for memory retrieval. Deno KV is used for lightweight ingest state, dedupe, and embedding queues, and Deno Deploy hosts the kernel API.

## Goals

- Store an embedding for every inbound GitHub message processed by the kernel.
- Keep memory forever (no TTL) while retaining the original text and metadata.
- Support cross-repo retrieval within an org, with optional global scope.
- Map actor identity directly to GitHub user id (no separate identity system yet).
- Add a simple query API for the router/agent to fetch related context.

## Non-goals

- Privacy controls, deletion requests, or retention enforcement.
- Cross-platform identity resolution (beyond GitHub).
- Full-text search features (vector similarity only for now).
- Hard real-time embedding generation on critical request paths (latency-sensitive flows should be async).

## Current kernel behavior (reference)

- Inbound events are handled via Hono in `src/kernel.ts`.
- GitHub comment handlers live in:
  - `src/github/handlers/issue-comment-created.ts`
  - `src/github/handlers/issue-comment-edited.ts`
  - `src/github/handlers/pull-request-review-comment-created.ts`
  - `src/github/handlers/pull-request-review-comment-edited.ts`
- Deno KV is already used for lightweight state and dedupe in:
  - `src/github/utils/comment-dedupe.ts`
  - `src/github/utils/agent-memory.ts`

## Existing embeddings plugin alignment

- Implementation: `lib/plugins/text-vector-embeddings` (HTTP plugin).
- Storage: Supabase tables `issues` and `issue_comments` with `embedding vector(1024)` plus `payload` JSON.
- IDs: uses GitHub `node_id` for issue/comment ids (string).
- Model: Voyage AI `voyage-large-2-instruct` (1024 dims).
- Events: `issue_comment.*` and `issues.*` (no PR review comments yet).

## Architecture overview

### Ingest flow

1. Kernel dispatches the `text-vector-embeddings` plugin for supported events.
2. Plugin normalizes text (strip HTML comments, remove plugin footnotes) and stores rows in Supabase.
3. Embedding jobs are queued in KV and processed asynchronously (rate-limited).
4. Kernel queries Supabase for relevant memory snippets.

### Retrieval flow

1. Router builds a query string from the incoming message and context.
2. Kernel generates an embedding for the query string.
3. Supabase vector search returns the top-k similar chunks.
4. Kernel filters/weights by scope (repo/org/global) and recency.
5. Kernel injects a short memory snippet with source links into the prompt.

### Storage layers

- Supabase Postgres (pgvector): system of record for messages and embeddings.
- Deno KV: ingest state, embedding queue, and short-lived cache for embeddings or query results.

## Data model (Supabase)

Reuse the existing plugin schema and add a unified view for retrieval.

```
create extension if not exists vector;

create table issues (
  id varchar primary key,             -- GitHub node_id
  markdown text,
  plaintext text,
  embedding vector(1024) not null,
  payload jsonb,
  author_id varchar not null,
  created_at timestamptz not null default now(),
  modified_at timestamptz not null default now()
);

create table issue_comments (
  id varchar primary key,             -- GitHub node_id
  issue_id varchar references issues(id) on delete cascade,
  markdown text,
  plaintext text,
  embedding vector(1024) not null,
  payload jsonb,
  author_id varchar not null,
  created_at timestamptz not null default now(),
  modified_at timestamptz not null default now()
);

create index issues_embedding_hnsw
  on issues using hnsw (embedding vector_cosine_ops);

create index issue_comments_embedding_hnsw
  on issue_comments using hnsw (embedding vector_cosine_ops);

create view memory_messages as
  select
    'issue'::text as source_type,
    id as source_id,
    payload->'repository'->>'name' as repo,
    payload->'repository'->'owner'->>'login' as owner,
    payload->'issue'->>'html_url' as source_url,
    payload->'issue'->>'number' as issue_number,
    author_id,
    markdown,
    plaintext,
    embedding,
    created_at,
    modified_at
  from issues
  union all
  select
    'issue_comment'::text as source_type,
    id as source_id,
    payload->'repository'->>'name' as repo,
    payload->'repository'->'owner'->>'login' as owner,
    payload->'comment'->>'html_url' as source_url,
    payload->'issue'->>'number' as issue_number,
    author_id,
    markdown,
    plaintext,
    embedding,
    created_at,
    modified_at
  from issue_comments;
```

Notes:

- The view uses `payload` JSON to derive `owner`, `repo`, and URLs; add computed columns later if needed.
- For async embeddings, make `embedding` nullable and add `embedding_status` + `embedding_model`.
- Long messages can be chunked later; keep chunk metadata in a future table if needed.

## Embedding generation

- Default model: Voyage AI `voyage-large-2-instruct` (1024 dims) to match the existing plugin.
- Store `embedding_model` and `embedding_dim` per row to support re-embedding later.
- If the message body changes (edited comment), update the existing row and refresh the embedding.

### Queueing and rate limits

- Use Deno KV as the embedding queue to respect Voyage rate limits on the free tier.
- Enqueue `{ table, id, attempt }` when a row is inserted/updated.
- A scheduled worker drains N jobs per run (token bucket), with backoff on 429s.
- Successful jobs set `embedding_status = 'ready'` and fill `embedding`.

### Provider integration

Two viable paths (either is fine for MVP):

1. Call Voyage AI directly from the plugin/kernel using `VOYAGEAI_API_KEY`.
2. Add a `/v1/embeddings` endpoint to `ai.ubq.fi` (same GitHub token verification as chat).

The second option keeps provider keys off the kernel and is the preferred long-term shape.

## Query API (kernel)

Add a small helper in the kernel that can be called from the router or agent:

```
searchMemory({
  tenantId,
  owner,
  repo,
  scope: 'repo' | 'org' | 'global',
  queryText,
  limit,
  minSimilarity,
  includeSourceText
})
```

Default behavior:

- Scope: `org` (tenant-wide, but prefer same repo in scoring).
- Limit: 6-10 chunks.
- Similarity threshold: reject weak matches (tunable).

Returned snippet format (example):

```
[owner/repo#123] "short excerpt..." (https://github.com/.../issues/123#issuecomment-...)
```

## Scope and identity

- `actor_id` is the GitHub numeric user id (simple mapping for now).
- `tenant_id` should default to the GitHub App installation id; store `owner`/`owner_id` for org scoping.
- Scope is determined by `tenant_id` plus optional filters:
  - `repo` scope: owner+repo filter
  - `org` scope: owner filter (within tenant)
  - `global` scope: tenant-only, no owner filter
- Cross-org retrieval is allowed only when explicitly set to `global`.

## Ingest sources

MVP sources (handled by the existing plugin):

- `issue_comment.created`
- `issue_comment.edited`
- `issues.opened`
- `issues.edited`

Phase 2 sources:

- `pull_request_review_comment.created` and `pull_request_review_comment.edited`
- `pull_request.opened` (PR title + body)
- `push` event to backfill `specs/*.md` (optional, configurable)

## Deno KV usage

- Dedupe reuse: use the existing `comment-dedupe` logic to avoid duplicate ingest.
- Queue: use KV enqueue plus backoff to process embeddings async (Voyage RPM protection).
- Cache (optional): short-lived cache for recent query embeddings or results.

## Observability

- Log ingest failures with the source url and body hash.
- Track counts of `pending`, `ready`, and `failed` embeddings.
- Keep a small error table in Supabase for retries if needed.

## Deployment and configuration

Add env vars:

- `SUPABASE_URL`
- `SUPABASE_KEY` or `SUPABASE_SERVICE_ROLE_KEY`
- `VOYAGEAI_API_KEY`
- `DENO_KV_URL` (for Deploy KV or local)
- `MEMORY_TENANT_ID` (default: GitHub App installation id; fallback to owner id)
- `UBQ_AI_BASE_URL` (reuse if ai.ubq.fi hosts `/v1/embeddings`)

## Implementation phases

### Phase 0: Reuse existing plugin + read path

- Keep `text-vector-embeddings` plugin ingest as-is.
- Add the `memory_messages` view and HNSW indexes.
- Add kernel search helper and wire it into router prompts.

### Phase 1: Queue embeddings (free tier friendly)

- Allow nullable embeddings + `embedding_status`.
- Add KV queue + scheduled worker with rate limiting.

### Phase 2: Expand ingest

- Add PR review comments and PR bodies.
- Index `specs/*.md` and other agreed doc sources.
- Add a simple backfill command (admin only).

### Phase 3: Roll ingest into kernel (optional)

- Move plugin logic into kernel once stable.
- Keep schema and query surface unchanged.

## Acceptance criteria

- Every inbound comment event results in a stored message row.
- Querying memory returns relevant cross-repo conversations with source urls.
- The router can include memory snippets without exceeding prompt budgets.
- All data is persisted in Supabase with no TTL.

## References

- https://supabase.com/docs/guides/ai/vector-columns
- https://supabase.com/docs/guides/database/extensions/pgvector
- https://supabase.com/docs/guides/ai/automatic-embeddings
- https://supabase.com/blog/fewer-dimensions-are-better-pgvector
- https://docs.deno.com/api/deno/~/Deno.Kv
- https://docs.deno.com/deploy/reference/deno_kv/
