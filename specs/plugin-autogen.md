# Plugin Autogen & Marketplace Installation

Status: Draft  
Last updated: 2025-12-19

## Summary

Define a safe, PR-driven system that lets **UbiquityOS**:

1. Reuse existing marketplace plugins when a request matches prior automations.
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
- Search marketplace inventory (by event + keywords).
- Propose install via PR to the target repo’s config.

2) **Create new plugin**
- Scaffold a new marketplace repo.
- Implement plugin behavior.
- Test against sandbox issue/PR.
- Propose install via PR to the target repo’s config.

### Safety posture

- Only **OWNER/MEMBER/COLLABORATOR** can trigger “plugin autogen” actions.
- All repo-changing actions occur in GitHub Actions (agent workflow), with:
  - checkout of the target repo,
  - PR creation,
  - explicit bot-visible status via request-comment HTML block.

## Inventory & discovery (what plugins exist?)

### Inventory sources

Start simple (works for ~10–50 plugins):

1. **Installed plugins for this repo** (already in config): immediate candidates.
2. **Marketplace inventory**: enumerate repos in `ubiquity-os-marketplace` and fetch `manifest.json`.

Optional optimization once the inventory grows:

- A single registry file: `ubiquity-os-marketplace/registry.json` (generated nightly) containing the important subset of each manifest.
- Cache the parsed inventory in Deno KV with a short TTL (e.g., 30–120 minutes).

### Event-aware filtering (recommended first filter)

Manifests already support:

- `manifest["ubiquity:listeners"]`: which webhook events the plugin supports.

At routing/install time:

1. Determine current event (`issue_comment.created`, `pull_request_review_comment.created`, etc.).
2. Filter candidate plugins to those whose listeners include that event.
3. Only then do keyword / intent matching.

This keeps matching predictable and avoids irrelevant plugins.

## “Should we create a new plugin?”

Creation should be explicit in Phase 1:

- `@ubiquityos agent create an automation plugin for: <task>`
- or a dedicated slash command like `/automation <task>` (recommended once implemented).

Later phases can auto-suggest creation if:

- the same intent repeats N times in a repo/org, or
- agent runs repeatedly “do the same thing” with high compute / long runtime.

## Data model (Deno KV)

We need two categories of KV data:

### 1) Operational memory (recent runs / UX)

Already implemented: store small “agent run notes” as per-run KV entries keyed by repo and time.

This helps the router/agent avoid repeating known failure modes, without storing full threads.

### 2) Autogen signals

Recommended minimal metrics (per repo):

- `intent_counts`: `{ intentKey -> count }`
- `intent_last_seen`: `{ intentKey -> isoTimestamp }`
- `intent_best_plugin`: `{ intentKey -> pluginId }` (optional)

Recommended minimal metrics (per org):

- `plugin_usage_counts`: `{ pluginId -> count }`
- `plugin_success_rate`: `{ pluginId -> ok/failed }` (optional)

Implementation note: avoid large single KV values; use per-key records and `kv.list({ prefix }, { reverse, limit })`.

## Local development (KV)

This design assumes **Deno KV** in production (Deno Deploy). For local work, there are a few options:

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

## Autogen workflow (end-to-end)

### Flow A — Install an existing plugin

1. User invokes autogen intent (admin-only).
2. Agent searches marketplace inventory (event filter + keyword match).
3. Agent opens an **Install PR** in the target repo:
   - Edits `.github/.ubiquity-os.config.<env>.yml` (based on kernel `ENVIRONMENT`).
   - Adds plugin entry at the correct ref (default `development` during testing).
4. Agent comments back (or updates request comment) with:
   - install PR link
   - what it enables
   - how to invoke it

### Flow B — Create a new plugin + install

1. User invokes autogen intent (admin-only).
2. Agent searches inventory; finds no good fit.
3. Agent scaffolds a new repo in `ubiquity-os-marketplace`:
   - Naming: `command-<intent>` or `daemon-<intent>` (clear purpose).
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
- Default branch policy for new plugins (development vs main).
- Review policy for plugin repos (required reviewers / protected branches).
