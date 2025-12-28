# Fallback Audit Index

Ordering is low risk first, then medium, then high. Detailed plans live in the referenced files.

## Low Risk (details in `reports/fallbacks/01-low-risk.md`)
- `AGENTS.md` auth fallback note
- `specs/command-codex.md` LLM auth fallback instructions
- `specs/message-embeddings.md` tenant id fallback
- `specs/plugin-autogen.md` registry/KV fallback notes
- `lib/plugin-sdk/CHANGELOG.md` historical fallback entry
- `lib/plugins/command-start-stop/CHANGELOG.md` historical fallback entries
- `lib/plugins/text-conversation-rewards/CHANGELOG.md` historical fallback entries
- `scripts/agent-bus.mjs` token fallback
- `scripts/test-command.ts` wait-for-comment fallback
- `lib/ai.ubq.fi/scripts/ubq-ai.ts` token fallbacks
- `lib/plugins/text-vector-embeddings/scripts/migrate-supabase.ts` env fallback
- `tests/commands.test.ts` fallback base URL fixture

## Medium Risk (details in `reports/fallbacks/02-medium-risk.md`)
- `lib/plugins/daemon-xp/src/handlers/handle-issue-unassigned.ts` display handle fallback
- `lib/plugins/daemon-merging/CI/src/check-inactivity.ts` inactivity date fallback
- `lib/plugins/daemon-merging/CI/src/merge.ts` unexpected status fallback
- `lib/plugins/daemon-disqualifier/src/helpers/remind-and-remove.ts` reminder posting fallback
- `lib/plugins/daemon-pricing/src/utils/time.ts` bot initiator fallback
- `lib/plugins/daemon-pricing/src/utils/time-labels.ts` label selection fallback
- `lib/plugins/text-vector-embeddings/src/utils/embedding-queue.ts` config defaults fallback
- `lib/plugins/text-vector-embeddings/src/handlers/annotate.ts` footnote insertion fallback
- `lib/plugins/text-vector-embeddings/src/handlers/issue-deduplication.ts` footnote insertion fallback
- `lib/plugins/text-conversation-rewards/src/parser/content-evaluator-module.ts` prompt/spec fallback

## High Risk (details in `reports/fallbacks/03-high-risk.md`)
- `src/github/types/env.ts` fallback base URL env
- `src/github/github-event-handler.ts` fallback base URL config
- `src/kernel.ts` fallback base URL wiring
- `src/github/handlers/issue-comment-created.ts` router fallback requests
- `lib/plugins/command-config/src/adapters/openai/call-llm.ts` fallback base URL
- `lib/plugin-sdk/src/configuration.ts` manifest fallback normalization
- `src/github/utils/plugins.ts` manifest fallback normalization
- `lib/plugins/command-start-stop/src/utils/issue.ts` fallback issue/PR fetch
- `lib/plugins/command-start-stop/src/utils/get-pull-requests-fallback.ts` fallback fetch helpers
- `lib/plugins/command-config/src/helpers/target-scope.ts` config path fallback
