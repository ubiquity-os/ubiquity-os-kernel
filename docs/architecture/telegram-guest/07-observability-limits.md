# Observability, Limits, and Failure Modes

## Owner (Suggested Agent)

Agent: `observability-limits`

## What To Measure

Per request:
- `requestId`
- `workspaceId` (hashed in logs if needed)
- latency breakdown:
  - KV read/write
  - memory search call
  - LLM/router call
  - plugin dispatch call
  - Telegram sendMessage

Per workspace (rolling windows):
- inbound message count
- LLM calls
- plugin dispatches
- memory index/search calls

Per service:
- error rates by endpoint + status code
- timeout rates
- retry counts

## Timeouts and Retries

Guest path must be resilient and prioritize user experience:

- Memory search: short timeout (e.g., 1-2s). Fail open (continue without memory).
- Memory index: short timeout (e.g., 1-2s). Best-effort.
- LLM/router: moderate timeout (e.g., 20-30s). Retry only on 5xx, not on 4xx.
- Plugin dispatch: moderate timeout (e.g., 10-20s). Prefer deterministic error messages on failure.
- Telegram sendMessage: retries with backoff on transient failures.

## Telegram Limits

Telegram constraints that matter:
- message size limit: 4096 chars
- rate limits per bot token (practically enforced)

Mitigations:
- chunk long messages
- collapse multi-message plugin results when possible
- queue outbound sends if needed (KV-backed queue if serverless)

## Memory Limits (Vector DB)

Failure modes:
- embedding provider rate limits
- vector DB transient failures
- index growth with forever retention

Mitigations:
- skip short/noisy messages
- async indexing
- caps on search `topK`
- eventual memory compaction (future)

## LLM Costs

Primary driver: prompt size and call frequency.

Mitigations:
- keep transcript window small (last N messages)
- include memory snippets only when relevant
- avoid including large blobs by default

## GitHub Caveat (Runtime Dependencies)

Hosting plugin code on GitHub is fine.

Avoid GitHub as a runtime dependency in guest mode:
- do not dispatch guest plugins via GitHub Actions
- do not fetch manifests/config from GitHub per request
- do not store guest transcripts in GitHub issues

If any of the above are used, all guest users share:
- GitHub API rate limits per installation/token
- Actions queue/concurrency limits

That becomes a scaling bottleneck and introduces external downtime into the assistant UX.

## Error Messaging

User-facing errors should be short and actionable:
- "Memory is temporarily unavailable; continuing without it."
- "That plugin is currently unavailable."
- "You're sending messages too quickly; try again in 10 seconds."

Do not leak internal stack traces to Telegram.

