# Marketplace Plugin Install & Generation

Status: Draft  
Last updated: 2025-12-19

## Summary

Define a safe, PR-driven system that lets **UbiquityOS**:

1. Reuse existing marketplace plugins when a request matches a known capability.
2. Generate a new plugin repo when no good fit exists.
3. Test the plugin against a sandbox issue/PR.
4. Install it by opening a PR that edits the active `.github/.ubiquity-os.config*.yml`.

This is intentionally **not fully autonomous**: enabling a new automation in a real repo must happen via a PR that a maintainer merges.

## Background (current kernel model)

The kernel already does three key things that this system builds on:

- Loads repo/org config from `.github/.ubiquity-os.config*.yml` (see `src/github/utils/config.ts`).
- Fetches each plugin’s `manifest.json` (see `src/github/utils/plugins.ts`).
- Routes issue comments:
  - Deterministic: slash commands (directly dispatches the matching plugin).
  - LLM router: `@ubiquityos …` chooses `reply | command | agent` and dispatches accordingly (see `src/github/handlers/issue-comment-created.ts`).

We already have a PR-based config editor pattern:

- `lib/plugins/command-config` edits the active config via an LLM and opens a PR for maintainers to merge.

## Dispatch contract (kernel → GitHub Actions plugin)

GitHub Actions plugins are invoked via `workflow_dispatch` with a fixed set of inputs (see `src/github/types/plugin.ts`).

Key details for generated plugins:

- `inputs.eventPayload` is a compressed JSON string; plugins should decompress it (or use plugin-sdk utilities).
- `inputs.settings` is a JSON string of the plugin config.
- `inputs.authToken` is a GitHub App installation token (use it for GitHub API calls).
- `inputs.command` is a JSON string shaped like `{"name":"<command>","parameters":{...}}` (not a plain string like `"ping"`).
- `inputs.signature` must be verified by the plugin (required for security).
- GitHub `workflow_dispatch` requires the workflow file to exist on the plugin repo default branch.

## GitHub Actions indexing lag (new repos)

Newly created plugin repos can temporarily return `404 Not Found` for `workflow_dispatch` even when
`.github/workflows/compute.yml` exists, due to GitHub Actions indexing delay.

Mitigations:

- Kernel: add a short linear polling retry on dispatch (preferred UX).
- Agent runs: when validating a newly created plugin, poll `GET /actions/workflows` until the workflow appears before
  dispatching test runs.
- Plugin scaffolding: include a cheap `on: push` trigger (filtered to `.github/workflows/compute.yml`) and guard the real
  job with `if: github.event_name == 'workflow_dispatch'` so the initial commit forces indexing without doing work.

## Current state (today)

- Marketplace registry exists at `ubiquity-os-marketplace/.ubiquity-os/.github/ubiquity-os-marketplace.plugin-registry.json`.
- “Install existing plugin” works end-to-end via `command-config` (PR-based config edit + registry-backed plugin resolution).
- “Create new plugin repo” is the next milestone; this doc defines the guardrails + workflow.

## Goals

- **Inventory-aware**: prefer installing/reusing an existing plugin over creating a duplicate.
- **Event-aware**: only consider plugins that can run on the current GitHub event.
- **PR-first installation**: config changes are proposed via PR, never silently enabled.
- **Sandbox-first validation**: new plugins must pass a test harness run before proposing installation.
- **Low friction** for maintainers: clear PR description, manifest “when to use”, and a stable command interface.

## Non-goals (initial)

- Auto-merging PRs that enable new automations.
- Auto-generating pricing logic / price labels (leave to existing downstream automations).
- Broad “unprompted bot” behavior (chiming in without mention).

## Terminology

- **Kernel**: the deployed serverless webhook handler.
- **Router**: the “reasoning_effort=none” model that chooses `help|ignore|reply|command|agent`.
- **Agent run**: privileged Codex execution in GitHub Actions (`.github/workflows/agent.yml`).
- **Marketplace plugin**: a plugin repo (GitHub Action or HTTP worker) with a `manifest.json`.
- **Install PR**: a PR that edits `.github/.ubiquity-os.config*.yml` to enable a plugin.

## High-level architecture

### Two capability tracks

1) **Install existing plugin**
- Search marketplace inventory (by event + intent matching).
- Propose install via PR to the target repo’s config.

2) **Create new plugin**
- Scaffold a new marketplace repo.
- Implement plugin behavior.
- Test against sandbox issue/PR.
- Propose install via PR to the target repo’s config.

### Safety posture

- Only **OWNER/MEMBER/COLLABORATOR** can trigger plugin install/generation actions.
- All repo-changing actions occur in GitHub Actions (agent workflow), with:
  - checkout of the target repo,
  - PR creation,
  - explicit bot-visible status via request-comment HTML block.

## Inventory & discovery (what plugins exist?)

### Inventory sources

Start simple (works for ~10–50 plugins):

1. **Installed plugins for this repo** (already in config): immediate candidates.
2. **Marketplace registry (preferred)**: a single JSON file in `ubiquity-os-marketplace/.ubiquity-os` that contains the
   important subset of each plugin’s manifest + metadata for routing/selection:
   - `ubiquity-os-marketplace/.ubiquity-os/.github/ubiquity-os-marketplace.plugin-registry.json`
3. **Fallback (if registry is unavailable)**: enumerate repos in `ubiquity-os-marketplace` and fetch `manifest.json`.

Optional optimization once the inventory grows:

- Cache the parsed registry in Deno KV with a short TTL (e.g., 30–120 minutes), and include only top‑K candidates in the
  router prompt.

### Event-aware filtering (recommended first filter)

The plugin manifest schema supports `manifest["ubiquity:listeners"]` (array of webhook event names).
The marketplace registry flattens this to `manifest.listeners` for routing/selection convenience.

At routing/install time:

1. Determine current event (`issue_comment.created`, `pull_request_review_comment.created`, etc.).
2. Filter candidate plugins to those whose listeners include that event (when present).
3. Only then do intent matching (prompt-driven; no code keyword triggers).

This keeps matching predictable and avoids irrelevant plugins.

## “Should we create a new plugin?”

Creation should be explicit in Phase 1 (to avoid accidental “repo sprawl”), but **not** via brittle keyword checks in code.
Examples of explicit user intent:

- `@ubiquityos agent create a plugin that: <task>`
- `@ubiquityos agent turn this repeated workflow into a marketplace plugin: <task>`

Later phases can auto-suggest creation if:

- the same intent repeats N times in a repo/org, or
- agent runs repeatedly “do the same thing” with high compute / long runtime.

## Data model (Deno KV)

We need two categories of KV data:

### 1) Operational memory (recent runs / UX)

Already implemented: store small “agent run notes” as per-run KV entries keyed by repo and time (see `src/github/utils/agent-memory.ts`).

This helps the router/agent avoid repeating known failure modes, without storing full threads.

### 2) Plugin generation signals

Recommended minimal metrics (per repo):

- `intent_counts`: `{ intentKey -> count }`
- `intent_last_seen`: `{ intentKey -> isoTimestamp }`
- `intent_best_plugin`: `{ intentKey -> pluginId }` (optional)

Recommended minimal metrics (per org):

- `plugin_usage_counts`: `{ pluginId -> count }`
- `plugin_success_rate`: `{ pluginId -> ok/failed }` (optional)

Implementation note: avoid large single KV values; use per-key records and `kv.list({ prefix }, { reverse, limit })`.

## Local development (KV)

This design assumes **Deno KV** in production (Deno Deploy). Locally, the kernel typically runs under Wrangler/workerd,
so `Deno.openKv()` won’t be available; the current code uses an in-memory fallback where needed.
For KV-focused work, there are a few options:

- **Best fidelity (recommended): run the kernel under Deno**, so `Deno.openKv()` is available and persists to a local SQLite
  file (or `:memory:` for tests).
- **Networked KV (optional): run `denokv` locally** (Docker) and connect via `Deno.openKv("http://localhost:4512")` with an
  access token. This matches “remote KV” semantics more closely.
- **Fallback (acceptable for unit tests only): in-memory KV adapter**, used when the runtime is not Deno (e.g., Bun-based dev
  server). This should not be used to validate persistence or cross-request behavior.

Notes:
- KV has a **64 KiB per-value** limit and **~2 KiB per-key** serialized limit, so “append-only event keys” are preferred over
  a single growing document.
- Deno Deploy free-tier KV limits (storage + ops) should be monitored as usage grows; if needed, add TTL or aggregation.

## End-to-end workflow

### Flow A — Install an existing plugin

1. User requests enabling/installing a marketplace plugin (admin-only).
2. Agent searches marketplace inventory (event filter + intent matching).
3. Agent opens an **Install PR** in the target repo:
   - Edits `.github/.ubiquity-os.config.<env>.yml` (based on kernel `ENVIRONMENT`).
   - Adds plugin entry without `@ref` (defaults to the plugin repo’s default branch, typically `main`) unless a specific ref is explicitly requested.
4. Agent comments back (or updates request comment) with:
   - install PR link
   - what it enables
   - how to invoke it

### Flow B — Create a new plugin + install

1. User explicitly requests creating a marketplace plugin (admin-only).
2. Agent searches inventory; finds no good fit.
3. Agent scaffolds a new repo in `ubiquity-os-marketplace`:
   - Naming: `command-<intent>` or `daemon-<intent>` (clear purpose).
   - Default branch: create the initial commit on `main` (so the plugin is usable immediately via `workflow_dispatch`).
   - Adds `manifest.json` including:
     - `short_name`, `description`
     - `ubiquity:listeners` (must include the intended event)
     - `commands` (if slash/command style)
     - **“When to use”** in `description` (until a dedicated field exists).
   - Adds a GitHub Actions workflow (`compute.yml`) matching the kernel’s dispatch contract.
4. Agent creates a PR in the plugin repo (or pushes directly if policy allows).
5. Agent validates:
   - manifest schema passes,
   - minimal mocked tests pass,
   - end-to-end dispatch works against a sandbox issue/PR (see Testing).
6. If validation passes, agent opens an **Install PR** in the target repo config.

## Testing strategy

Minimum test gate before proposing install:

- Validate `manifest.json` schema locally.
- Run the plugin’s own tests (mocked MSW/Jest patterns where possible).
- End-to-end in a sandbox repo:
  - Create a test issue.
  - Invoke the plugin via comment.
  - Verify the expected GitHub side effects (comment edits, labels, PR links, etc.).

Prefer using/expanding `scripts/test-command.ts` as the unified local harness.

Examples:

- `bun run scripts/test-command.ts comment https://github.com/0x4007/ubiquity-os-sandbox/issues/20 "@ubiquityos install daemon-planner"`
- `bun run scripts/test-command.ts comment https://github.com/0x4007/ubiquity-os-sandbox/issues/11 "@UbiquityOS agent rewrite the spec and set the best Time/Priority labels"`

## Configuration editing (PR-based)

Use the `command-config` PR-edit model:

- Agent produces a PR that changes the relevant `.github/.ubiquity-os.config*.yml`.
- PR body includes:
  - what changed
  - how to roll back (revert PR)
  - example invocation(s)

## Routing integration (“when to use it”)

Two layers:

1. **Deterministic** (best): give the plugin a slash command or explicit tool name.
2. **Router**: include short “when to use” + examples in manifest description so the router can choose it for `@ubiquityos …`.

If we need stronger routing later:

- Add a manifest field like `ubiquity:when_to_use` (string) and `ubiquity:intents` (array of strings) and include those in router command descriptions.

## Security considerations

- Treat issue/PR content as untrusted input (prompt injection is expected).
- Never auto-enable new plugins without a maintainer-reviewed PR.
- Keep secrets out of prompts and logs; prefer token scoping and minimal env inheritance.
- Ensure plugin repos enforce signature verification (the kernel already signs dispatch payloads).

## Phased rollout plan

Phase 1 (manual, safest)
- Implement “install existing plugin” as an admin-only agent capability.
- Implement “create plugin repo + PR” as an explicit admin-only action.

Phase 2 (suggestions)
- Kernel/router can suggest “this looks automatable; want me to create a plugin?” but does not act without confirmation.

Phase 3 (inventory scaling)
- Add marketplace registry cache (KV + optional nightly generated registry file).
- Optional: embeddings for retrieval when plugin count grows (not needed now).

## Open questions

- Marketplace org choice: `ubiquity-os-marketplace` vs a dedicated “generated plugins” org.
- Review policy for plugin repos (required reviewers / protected branches).

## Journal

### 2025-12-19

Done:
- Kernel: added linear retry for `workflow_dispatch` `404` + fail-fast check when `compute.yml` is missing from the plugin repo default branch.
- Kernel: added comment-event de-dupe (by event + comment id) to reduce double executions from repeated webhook deliveries.
- Kernel: prevented double replies by skipping global plugin dispatch for **command plugins** when the triggering comment is a **slash command** (the slash router owns command invocation).
- Agent workflow: clarified `inputs.command` JSON shape and GitHub Actions indexing/default-branch requirements for newly created plugin repos.
- Spec: documented dispatch contract + indexing lag mitigations.

Next goals:
- Plugin scaffolding: ensure `compute.yml` exists on the plugin repo default branch; add a cheap `on: push` trigger to force indexing while guarding real work to `workflow_dispatch` only.
- Local harness: extend `scripts/test-command.ts` to post a synthetic comment event so install → invoke can be exercised end-to-end without manual GitHub UI steps.
- Repeatable testing: keep a long-lived “smoke” command plugin installed in the sandbox config (e.g., `/smoke`) and reuse it as an end-to-end health check, rather than creating/deleting repos for every test run.
- Optional: implement KV “generation signals” (intent counts) to enable “want me to turn this into a plugin?” suggestions later.

Decisions:
- Default branch policy: create new marketplace plugin repos on the org default branch (currently `main`) so they are usable immediately via `workflow_dispatch`.
