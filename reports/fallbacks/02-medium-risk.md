# Medium Risk Fallback Plans

These items affect runtime behavior but are scoped to specific plugins or flows.

## daemon-xp display handle fallback
References:
- `lib/plugins/daemon-xp/src/handlers/handle-issue-unassigned.ts:231`
- `lib/plugins/daemon-xp/src/handlers/handle-issue-unassigned.ts:182`
- `lib/plugins/daemon-xp/src/handlers/handle-issue-unassigned.ts:183`
Context:
- `getDisplayHandle` falls back to using an id when login is missing.
Plan:
1. Require a valid login string when building `details.assignee`/`details.collaborators` (normalize once upstream).
2. If login is missing, omit the entry and log a single warning rather than rendering a fallback.
3. Update `getDisplayHandle` to accept only `string` and remove fallback logic.
Risk: Medium (user-visible formatting).
Validation:
- Run the daemon-xp handler tests or replay a sample event payload.

## daemon-merging inactivity check fallback
References:
- `lib/plugins/daemon-merging/CI/src/check-inactivity.ts:44`
Context:
- When no commits are found in the window, the code falls back to branch commit date.
Plan:
1. Pick a single source of truth for "last activity" (either branch head date always, or only human commits).
2. If using human commits only, treat "no commits" as a definitive skip with a reason (no fallback date).
3. Adjust logging so the reason is explicit and deterministic.
Risk: Medium (changes merge eligibility).
Validation:
- Run the CI script on a repo with empty and active branches to verify outcomes.

## daemon-merging unexpected status fallback
References:
- `lib/plugins/daemon-merging/CI/src/merge.ts:108`
Context:
- Unexpected merge API status returns a generic "skipped" fallback.
Plan:
1. Replace the fallback with an explicit error path (throw or return a typed error outcome).
2. Enumerate known statuses and handle each explicitly.
3. Update any downstream reporting to expect the new error outcome.
Risk: Medium (changes failure handling).
Validation:
- Exercise the merge flow with mock status codes.

## daemon-disqualifier reminder fallback
References:
- `lib/plugins/daemon-disqualifier/src/helpers/remind-and-remove.ts:237`
Context:
- If posting to a PR fails, it falls back to posting on the main issue.
Plan:
1. Choose a single target for reminders (issue OR PR) and document it.
2. Remove the secondary path and treat failures as errors with a clear log message.
3. If PR reminders are still needed, make the target explicit via configuration, not fallback.
Risk: Medium (changes where reminders appear).
Validation:
- Run the reminder flow against a PR and an issue to verify messaging.

## daemon-pricing time label initiator fallback
References:
- `lib/plugins/daemon-pricing/src/utils/time.ts:136`
- `lib/plugins/daemon-pricing/src/utils/time.ts:139`
Context:
- If a bot applied the label and the initiator cannot be inferred, the code falls back to admin rank.
Plan:
1. Require an explicit human initiator (comment author) for time label updates.
2. If initiator cannot be resolved, log and exit without applying changes.
3. Remove the "admin" fallback and update any permission logic that assumes it.
Risk: Medium (permission behavior).
Validation:
- Test a bot-applied label event and verify it now aborts cleanly.

## daemon-pricing time label selection fallback
References:
- `lib/plugins/daemon-pricing/src/utils/time-labels.ts:53`
Context:
- When no label is equal or higher, it falls back to the highest label.
Plan:
1. Treat "no equal-or-higher label" as an error and request a valid input instead of fallback.
2. Update user-facing messages with accepted label ranges.
3. Add a test for out-of-range inputs to confirm it errors.
Risk: Medium (user input handling).
Validation:
- Unit test `findClosestTimeLabel` with values above the max label.

## embedding queue defaults as fallback
References:
- `lib/plugins/text-vector-embeddings/src/utils/embedding-queue.ts:15`
- `lib/plugins/text-vector-embeddings/src/utils/embedding-queue.ts:29`
- `lib/plugins/text-vector-embeddings/src/utils/embedding-queue.ts:40`
Context:
- Env parsing falls back to defaults when values are missing or invalid.
Plan:
1. Move defaults into a single config source (env schema defaults or plugin config).
2. Treat missing/invalid values as configuration errors instead of falling back silently.
3. Remove the `fallback` parameters from parsers or replace with strict parsing helpers.
Risk: Medium (config validation).
Validation:
- Run a config validation test with missing and invalid env vars.

## text-vector-embeddings annotate fallback insertion
References:
- `lib/plugins/text-vector-embeddings/src/handlers/annotate.ts:172`
- `lib/plugins/text-vector-embeddings/src/handlers/annotate.ts:202`
Context:
- Footnote insertion tries a regex replace, then falls back to `insertFootnoteRefNearSentence`.
Plan:
1. Pick a single insertion strategy and use it consistently.
2. If insertion fails, record the footnote as orphan rather than retry with a different method.
3. Extract the chosen strategy into a shared helper for reuse.
Risk: Medium (comment body formatting).
Validation:
- Run the annotation flow on sample comments containing code blocks and plain text.

## text-vector-embeddings issue-deduplication fallback insertion
References:
- `lib/plugins/text-vector-embeddings/src/handlers/issue-deduplication.ts:222`
Context:
- Similar dual-path insertion with a fallback helper.
Plan:
1. Align with the single insertion strategy selected for annotate.
2. Share a helper to keep behavior identical across both handlers.
3. Remove the fallback branch and rely on orphan refs when insertion fails.
Risk: Medium (issue body formatting).
Validation:
- Run the deduplication handler against a fixture with missing sentence matches.

## text-conversation-rewards prompt fallback
References:
- `lib/plugins/text-conversation-rewards/src/parser/content-evaluator-module.ts:352`
- `lib/plugins/text-conversation-rewards/src/parser/content-evaluator-module.ts:482`
Context:
- When splitting cannot meet token limits, the code falls back to a full prompt. For PRs, it falls back to the provided specification if no closing issues are found.
Plan:
1. Define a single prompt shaping strategy that always enforces token limits (truncate or chunk deterministically).
2. Pick one specification source (either always provided spec or always closing issues) and remove implicit fallback.
3. Add explicit errors/logs for "no spec available" rather than swapping sources.
Risk: Medium (evaluation quality).
Validation:
- Run evaluation on a large comment set and verify token limit compliance.
