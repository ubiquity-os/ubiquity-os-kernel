# High Risk Fallback Plans

These items touch core routing, auth, or plugin discovery. Removing fallbacks here can impact availability and compatibility.

## command-start-stop issue/PR fallback fetch
References:
- `lib/plugins/command-start-stop/src/utils/issue.ts:37`
- `lib/plugins/command-start-stop/src/utils/issue.ts:185`
- `lib/plugins/command-start-stop/src/utils/get-pull-requests-fallback.ts:38`
- `lib/plugins/command-start-stop/src/utils/get-pull-requests-fallback.ts:74`
Context:
- On search failure, the plugin enumerates all repos and pulls as a fallback.
Plan:
1. Remove the fallback methods and surface a clear error when search APIs fail.
2. Add preflight checks for permissions and scopes so failures are explicit early.
3. Update any docs or logs that mention retrying with fallback.
Risk: High (behavior under restricted visibility and rate limits).
Validation:
- Run the plugin in a repo with private activity and verify the error path is clear.

## command-config target-scope path fallback
References:
- `lib/plugins/command-config/src/helpers/target-scope.ts:22`
- `lib/plugins/command-config/src/helpers/target-scope.ts:29`
- `lib/plugins/command-config/src/helpers/target-scope.ts:43`
Context:
- The plugin tries multiple config path candidates based on environment as a fallback chain.
Plan:
1. Require an explicit config path candidate list from settings (single path per run).
2. If no explicit path is provided, derive exactly one path and fail if missing.
3. Update any user-facing instructions to specify the chosen config path.
Risk: High (config discovery and installation).
Validation:
- Run a config edit flow with each supported environment to ensure the file path is deterministic.
