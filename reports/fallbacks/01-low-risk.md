# Low Risk Fallback Plans

These items are docs, tests, or local tooling. Changes should be safe if coordinated with runtime updates.

## AGENTS.md (auth fallback note)
References:
- `AGENTS.md:295`
Context:
- The auth section notes that legacy API keys/KV auth still work as a fallback.
Plan:
1. Replace the fallback note with a single supported auth path statement.
2. If legacy auth must remain temporarily, move it to a separate "Legacy" note with a deprecation timeline.
3. Update any cross-references so docs do not imply alternate paths.
Risk: Low (documentation only).
Validation:
- None.

## command-codex spec (LLM auth fallback)
References:
- `specs/command-codex.md:308`
- `specs/command-codex.md:390`
- `specs/command-codex.md:524`
- `specs/command-codex.md:539`
Context:
- The spec documents `OPENAI_API_KEY` as an optional fallback for Codex auth.
Plan:
1. Remove the fallback sections and keep `CODEX_AUTH_JSON_B64` as the only supported auth path.
2. Update steps and acceptance criteria to reference a single auth mechanism.
3. Add a short "missing auth" failure message template (no fallback guidance).
Risk: Low (documentation only).
Validation:
- None.

## message-embeddings spec (tenant id fallback)
References:
- `specs/message-embeddings.md:186`
- `specs/message-embeddings.md:262`
Context:
- The spec allows tenant id to fall back to installation id.
Plan:
1. Choose a single tenant id source (explicit `MEMORY_TENANT_ID` or org id) and document it.
2. Remove fallback language and clarify required inputs.
3. Add a migration note if existing data used installation ids.
Risk: Low (documentation only).
Validation:
- None.

## plugin-autogen spec (registry and KV fallbacks)
References:
- `specs/plugin-autogen.md:117`
- `specs/plugin-autogen.md:178`
- `specs/plugin-autogen.md:185`
Context:
- The spec documents a fallback inventory method and a fallback in-memory KV adapter.
Plan:
1. Select a single inventory path (registry only) and remove the fallback enumeration path.
2. Require Deno KV (or a single explicit KV provider) for local dev; drop in-memory fallback guidance.
3. Add a short "required runtime" section to set expectations.
Risk: Low (documentation only).
Validation:
- None.

## plugin-sdk changelog
References:
- `lib/plugin-sdk/CHANGELOG.md:139`
Context:
- Historical entry mentions a fallback to Deno.
Plan:
1. Do not rewrite history; keep the entry intact.
2. If needed, add a new top-level changelog entry describing fallback removal (without editing old text).
Risk: Low (docs/history only).
Validation:
- None.

## command-start-stop changelog
References:
- `lib/plugins/command-start-stop/CHANGELOG.md:97`
- `lib/plugins/command-start-stop/CHANGELOG.md:211`
- `lib/plugins/command-start-stop/CHANGELOG.md:339`
Context:
- Historical entries mention fallback methods.
Plan:
1. Preserve changelog history.
2. Add a new entry when fallback code is removed, rather than editing past entries.
Risk: Low (docs/history only).
Validation:
- None.

## text-conversation-rewards changelog
References:
- `lib/plugins/text-conversation-rewards/CHANGELOG.md:75`
- `lib/plugins/text-conversation-rewards/CHANGELOG.md:149`
- `lib/plugins/text-conversation-rewards/CHANGELOG.md:219`
- `lib/plugins/text-conversation-rewards/CHANGELOG.md:290`
Context:
- Historical entries mention fallback behavior.
Plan:
1. Preserve historical entries.
2. Add a new entry when fallback code is removed.
Risk: Low (docs/history only).
Validation:
- None.

## agent-bus script (token fallback)
References:
- `scripts/agent-bus.mjs:10`
- `scripts/agent-bus.mjs:55`
Context:
- The CLI falls back from `UOS_AGENT_AUTH_TOKEN` to `GH_TOKEN`.
Plan:
1. Require `UOS_AGENT_AUTH_TOKEN` explicitly (or a new `--token` flag) and remove the fallback.
2. Update usage text and error messages to list the single required token.
3. Rename `envOr` to `envRequired` to avoid implicit fallbacks.
Risk: Low (local tooling).
Validation:
- Run `node scripts/agent-bus.mjs --help` and one happy-path call with the explicit token.

## test-command script (comment fallback)
References:
- `scripts/test-command.ts:727`
Context:
- The script waits for a run URL, then falls back to waiting for an agent comment.
Plan:
1. Choose a single "success signal" (run URL or agent comment) and remove the secondary wait.
2. If both are needed, make it explicit via a `--wait-for` flag instead of fallback behavior.
3. Update log messages to reflect the single path.
Risk: Low (local tooling).
Validation:
- Run the script once with the chosen wait mode to confirm behavior.

## ubq-ai CLI (admin token fallback)
References:
- `lib/ai.ubq.fi/scripts/ubq-ai.ts:241`
- `lib/ai.ubq.fi/scripts/ubq-ai.ts:242`
- `lib/ai.ubq.fi/scripts/ubq-ai.ts:579`
Context:
- The CLI falls back from user token to admin token and from admin token to `DENO_DEPLOY_TOKEN`.
Plan:
1. Require explicit `--token`/`UBIQUITY_AI_USER_TOKEN` for client commands.
2. Require explicit `--admin-token`/`UBIQUITY_AI_ADMIN_TOKEN` for admin commands.
3. Remove `DENO_DEPLOY_TOKEN` fallback and adjust debug output accordingly.
Risk: Low (local tooling).
Validation:
- Run `scripts/ubq-ai.ts --help` and one command with explicit tokens.

## migrate-supabase script (env fallback)
References:
- `lib/plugins/text-vector-embeddings/scripts/migrate-supabase.ts:13`
- `lib/plugins/text-vector-embeddings/scripts/migrate-supabase.ts:14`
- `lib/plugins/text-vector-embeddings/scripts/migrate-supabase.ts:16`
- `lib/plugins/text-vector-embeddings/scripts/migrate-supabase.ts:17`
Context:
- The script accepts `SUPABASE_URL`/`SUPABASE_KEY` as fallbacks for source credentials.
Plan:
1. Require `SUPABASE_SOURCE_URL` and `SUPABASE_SOURCE_KEY` explicitly.
2. Remove fallback hints from error messages.
3. Update any local runbook or README references if present.
Risk: Low (one-off migration tool).
Validation:
- Dry-run with explicit `SUPABASE_SOURCE_URL`/`SUPABASE_SOURCE_KEY`.

## commands.test.ts (fallback test fixture)
References:
- `tests/commands.test.ts:67`
Context:
- Test fixture sets `aiFallbackBaseUrl` for the event handler.
Plan:
1. Remove `aiFallbackBaseUrl` from the fixture after runtime fallback removal.
2. Update any mocks that depend on multiple base URLs.
Risk: Low (test-only change).
Validation:
- Run `bun run jest:test -- tests/commands.test.ts` after runtime change.
