# `command-codex` — Codex CLI command plugin (GitHub Actions)

Status: Draft  
Last updated: 2025-12-15

## Summary

Add a new marketplace plugin, `ubiquity-os-marketplace/command-codex`, that allows trusted users to trigger agentic coding via GitHub comments (e.g. `/codex …` or `@ubiquityos …`). The plugin runs on **GitHub Actions**, wraps the **OpenAI Codex CLI** (`codex exec`), applies any produced diff, and returns results by opening/updating a PR and commenting back on the issue/PR.

Authentication goal: use **ChatGPT/Codex subscription auth** (not per-request API keys) by restoring Codex’s `auth.json` from a GitHub Actions secret (`CODEX_AUTH_JSON_B64`). The workflow should gracefully detect “unauthorized” and comment back with steps to refresh the secret.

This is intentionally implemented as a plugin (not in-kernel), so the kernel can stay lightweight and deployment-target agnostic (Deno Deploy, Workers, etc.), while agentic code execution happens in a sandboxed CI runner.

## Background / Existing Kernel Behavior

The kernel routes issue comments using two distinct paths (see `src/github/handlers/issue-comment-created.ts`):

### 1) Slash commands (no LLM, deterministic)

Examples: `/hello`, `/wallet`, `/codex …`

1. Loads enabled plugins from `.github/.ubiquity-os.config*.yml` (org + repo configs)
2. Fetches each plugin’s `manifest.json`
3. Finds the first plugin whose `manifest.commands` contains the slash command name
4. Dispatches that plugin directly via `workflow_dispatch` (GitHub Actions) or HTTP (Workers)

This is the preferred path for `command-codex`: `/codex <task>` is a direct invocation and does not require the kernel “brain”.

Note: `@ubiquityos /codex …` is treated as a slash command too (the mention is ignored and the `/…` portion is dispatched directly).

### 2) Mentions (LLM “brain” routing)

Examples: `@ubiquityos please …`, `@ubiquityos codex …`

1. Loads enabled plugins from `.github/.ubiquity-os.config*.yml` (org + repo configs)
2. Fetches each plugin’s `manifest.json`
3. Exposes `manifest.commands` as OpenAI tool definitions
4. Lets an LLM choose a single tool call
5. Dispatches the selected plugin via `workflow_dispatch` (GitHub Actions) or HTTP (Workers)

`command-codex` plugs into this path by defining a `codex` command in its `manifest.json`, allowing the kernel to select it for natural-language `@ubiquityos …` requests.

## Reference Implementations (in this repo)

The kernel already has working examples of both plugin _interfaces_:

### GitHub Actions plugins (workflow_dispatch)

These show the “standard” `workflow_dispatch` shape expected by the kernel (inputs, decompress, checkout target repo with `inputs.authToken`, env selection):

- `lib/plugins/command-ask/.github/workflows/compute.yml`
- `lib/plugins/daemon-pull-review/.github/workflows/compute.yml`

### Optional: Codex GitHub Action (`openai/codex-action`) (API key auth)

OpenAI publishes `openai/codex-action`, a composite action that installs the Codex CLI, configures a local Responses API proxy, and supports runner hardening via `safety-strategy` (default `drop-sudo`). It’s a good option if you choose to authenticate with an API key (pay-per-request).

- https://github.com/openai/codex-action
- Notable inputs: `prompt`, `prompt-file`, `working-directory`, `sandbox`, `model`, `effort`, `codex-args`, `safety-strategy`, `allow-bots`
- Notable output: `final-message` (Codex’s last message from `codex exec`)

Terminology (so it’s easier to reason about):

- Workflow-actor permission check: the action refuses to run unless the workflow actor has repo write access (or is explicitly allowed via `allow-users`, or `allow-bots: true` for GitHub Apps/bots). This prevents arbitrary commenters from triggering a run that has access to secrets.
- Responses proxy: the action runs `@openai/codex-responses-api-proxy` locally and configures Codex to talk to it, so the Codex process never needs direct access to the API key value (reduces key leakage risk).

Important: `openai/codex-action` is designed around API-key authentication (it starts a Responses proxy and expects `openai-api-key`). If you want to use ChatGPT/Codex subscription auth (`auth.json`), run `codex exec` directly after restoring `auth.json` (don’t use this action).

Note: you generally **do not** need to vendor this action (submodule/copy). Prefer `uses: openai/codex-action@v1` (or pin to a commit SHA) unless you need to customize or audit a fork.

### Worker plugin (HTTP)

This shows the simplest manifest/command declaration pattern (no args, command name routing in code):

- `lib/plugins/hello-world-plugin/manifest.json`
- `lib/plugins/hello-world-plugin/src/index.ts`

### Kernel input shape (minimal plugin)

This mock demonstrates the kernel payload contract (compressed `eventPayload`, JSON-stringified `settings` and `command`, plus `authToken`) and a minimal Octokit comment response:

- `tests/__mocks__/hello-world-plugin.ts`

## Goals

- Provide an **agentic “make changes in repo”** capability triggered by a GitHub comment.
- Run in **GitHub Actions** (not in kernel runtime).
- Use **Codex CLI** in non-interactive mode (`codex exec`) to produce edits and run commands/tests as needed.
- Produce a **PR (or PR update)** and **comment** back with a short summary + link.
- Enforce **strict authorization** (only trusted roles can run it).
- Avoid leaking secrets (mask tokens; minimize token exposure to agent runtime).

## Non-goals (initial version)

- Supporting PRs from forks (initially deny; too many auth/permission edge cases).
- Allowing arbitrary internet browsing/search during runs (keep off by default).
- Running for every comment event (must be explicitly invoked).
- Multi-step conversational sessions (single “command → run → result” loop).
- Guaranteed deterministic output; this is best-effort automation.

## User Experience

### Invocation (recommended)

Prefer explicit triggers. `/codex` is deterministic and bypasses the kernel LLM; `@ubiquityos codex …` keeps LLM routing but makes tool selection unambiguous:

- `/codex <task>`
- `@ubiquityos codex <task>`

Examples:

- `/codex add a CLI flag --dry-run and update README`
- `@ubiquityos codex please add unit tests for src/foo.ts`

### Bot response patterns

The plugin should post a comment indicating:

- Whether the request is accepted or rejected (and why)
- If accepted: a link to the created/updated PR (preferred)
- If no changes: a concise explanation + what to try next

Optional enhancements:

- React to the command comment with 👀/✅/❌ (or just a comment) for progress feedback
- Add a “Started run (stateId=…)” breadcrumb for tracing

## System Design

### High-level flow

There are two supported invocation flows:

#### A) `/codex …` (direct command, no LLM)

1. User posts comment `/codex …` on an issue/PR.
2. Kernel parses the slash command name and resolves the target plugin by scanning enabled plugin manifests for `commands.codex`.
3. Kernel dispatches `workflow_dispatch` to the plugin repo (`command-codex`), passing:
   - `eventPayload` (compressed JSON of the GitHub event payload, including the full comment body)
   - `authToken` (GitHub App installation token minted by kernel)
   - `settings` (plugin config `with:` serialized as JSON)
   - `command` (the slash command name + parsed JSON arguments, if any)
   - `stateId`, `eventName`, `ref`, `signature`, etc.
4. Plugin workflow runs Codex and posts results (PR/comment).

#### B) `@ubiquityos …` (LLM “brain” chooses a tool)

1. User posts a natural-language mention `@ubiquityos …` on an issue/PR.
2. Kernel routes into `commandRouter` and the LLM selects the `codex` tool (based on `manifest.commands.codex`).
3. Kernel dispatches `workflow_dispatch` to the plugin repo (`command-codex`), passing:
   - `eventPayload` (compressed JSON of the GitHub event payload)
   - `authToken` (GitHub App installation token minted by kernel)
   - `settings` (plugin config `with:` serialized as JSON)
   - `command` (selected tool name + JSON arguments)
   - `stateId`, `eventName`, `ref`, `signature`, etc.
4. Plugin workflow:
   - Decompresses payload
   - Validates authorization and safety constraints
   - Checks out the target repository using `authToken`
   - Runs `codex exec` in a constrained mode
   - Applies changes (if produced), commits, pushes a branch
   - Creates/updates PR
   - Posts result comment back on the originating issue/PR

### Why GitHub Actions (plugin) vs kernel runtime

- Kernel is deployed on serverless infrastructure where running an agentic CLI (git, compilers, package managers) is impractical.
- GitHub Actions provides:
  - A clean, ephemeral environment per run
  - Simple repo checkout and push workflows
  - Auditable logs and per-run isolation

## Command Contract

### `manifest.json` (plugin)

Define a single command:

- `commands.codex`
  - `ubiquity:example`: `/codex add a unit test for X`
  - `parameters`: keep minimal (see note below)

Recommended schema (matching the “hello world” pattern):

- Use **no tool parameters**, and parse the user’s task from the original comment body.
- This keeps the kernel tool schema trivial and avoids “required args” friction.

```json
{}
```

Task extraction rule (plugin-side, required safety check):

- Only proceed if the comment includes an explicit invocation:
  - starts with `/codex` (after optional `@UbiquityOS` rewrite), or
  - starts with `@ubiquityos codex`
- The `task` is the remaining text after the invocation token.

Alternative schema (acceptable if you prefer kernel-side arg extraction):

```json
{
  "type": "object",
  "properties": {
    "task": { "type": "string", "description": "What to implement/change" }
  }
}
```

Important note: the kernel currently treats all `parameters.properties` as required when building tool schemas. If you define `task`, it will be required. Prefer putting advanced tuning in plugin `settings` instead of adding many parameters.

## Plugin Settings (`with:`) — Proposed Configuration Surface

All settings are optional; defaults should be safe.

### Authorization / scope controls

- `allowedAuthorAssociations`: `string[]`
  - Default: `["OWNER", "MEMBER", "COLLABORATOR"]`
  - Compared against the triggering comment’s `author_association` (and/or permission checks via API).
- `allowedRepos`: `string[] | null`
  - Default: `null` (allow any repo the App is installed on)
  - If set, require `owner/name` match.
- `denyForkPRs`: `boolean`
  - Default: `true`
- `requireExplicitInvocation`: `boolean`
  - Default: `true`
  - If true, refuse to run unless the comment clearly contains `/codex` or `@ubiquityos codex` (prevents accidental invocation via the kernel’s LLM router).

### Codex execution controls

- `model`: `string`
  - Default: omit (Codex CLI default)
  - Passed as `codex exec --model <model>` (or `-m`)
- `effort`: `string | null`
  - Default: `null`
  - Passed via Codex config: `codex exec --config model_reasoning_effort="<effort>"`
- `sandbox`: `"read-only" | "workspace-write" | "danger-full-access"`
  - Default: `"workspace-write"`
  - Passed as `codex exec --sandbox <mode>` (or the equivalent global `codex --sandbox <mode> exec …`)
- `codexArgs`: `string | null`
  - Default: `null`
  - Extra args passed through to `codex exec` (e.g., `--json`, `--output-schema ...`, `--config ...`).

Note: if you use the API-key-based `openai/codex-action`, you can add runner hardening via its `safety-strategy` input (e.g. `drop-sudo`). The subscription-auth (restored `auth.json`) flow typically relies on sandboxing plus strict token minimization instead.
- `passAuthTokenToCodex`: `boolean`
  - Default: `false`
  - If true, expose `inputs.authToken` to Codex as `GH_TOKEN` (enables `gh`/GitHub API access inside the agent; increases prompt-injection blast radius).
- `maxRuntimeMinutes`: `number`
  - Default: `360` (GitHub Actions job timeout)
  - Recommendation: keep `<= 60` unless you implement GitHub token refresh

### Git/PR behavior

- `mode`: `"pr" | "commit-only" | "comment-only"`
  - Default: `"pr"`
  - `pr`: create/update PR, then comment with link
  - `commit-only`: push branch but do not create PR (still comment)
  - `comment-only`: do not push; just comment with suggested patch/diff summary
- `branchPrefix`: `string`
  - Default: `"ubiquityos/codex"`
- `commitMessage`: `string`
  - Default: `"codex: apply changes"`
- `draftPr`: `boolean`
  - Default: `true`
- `prTitleTemplate`: `string`
  - Default: `"Codex: #{issueNumber}"`
- `prBodyTemplate`: `string`
  - Default includes:
    - link to originating issue/PR
    - the original `task`
    - short Codex summary

### Validation (optional)

- `testCommand`: `string | null`
  - Default: `null`
  - If set, run after applying changes (e.g., `bun test`, `npm test`).

## Secrets & Authentication

### GitHub access (do NOT store in plugin secrets)

Use the kernel-provided `inputs.authToken` (GitHub App installation token) for:

- Checking out the target repository
- Pushing branches
- Creating PRs / commenting via GitHub API

Rationale:

- Token is minted per request by the kernel’s GitHub App auth.
- Keeps GitHub App private key out of the plugin.

### Codex / LLM access (store in plugin secrets)

Primary (subscription auth, preferred for this plugin):

- `CODEX_AUTH_JSON_B64` (base64 of a logged-in Codex CLI `auth.json`)
  - Produced on a trusted local machine after `codex login --device-auth` (or `codex login`)
  - Encode:
    - macOS: `base64 -i ~/.codex/auth.json | tr -d '\n'`
    - Linux: `base64 -w0 ~/.codex/auth.json`
  - Set (example using GitHub CLI + repo environments):
    - `base64 -i ~/.codex/auth.json | tr -d '\n' | gh secret set CODEX_AUTH_JSON_B64 -R <OWNER/REPO> -e development`
    - `base64 -i ~/.codex/auth.json | tr -d '\n' | gh secret set CODEX_AUTH_JSON_B64 -R <OWNER/REPO> -e main`

Optional fallback (pay-per-request API key, more CI-stable):

- `OPENAI_API_KEY`
  - Used via `printenv OPENAI_API_KEY | codex login --with-api-key`

Stability note: ChatGPT subscription auth is interactive and can expire/revoke; CI runs should detect auth failures (401/403) and comment back with refresh instructions instead of failing silently.

### Token/secret handling requirements

- Mask `inputs.authToken`, `CODEX_AUTH_JSON_B64`, and `OPENAI_API_KEY` immediately (GitHub Actions masking).
- Do not print decompressed payloads that may contain sensitive data.
- Prefer `actions/checkout` with `persist-credentials: false` so credentials aren’t left in `.git/config` during agent execution.
- Only inject a push-capable credential _after_ Codex finishes, right before pushing.
- Avoid exposing `inputs.authToken`/`GITHUB_TOKEN`/`GH_TOKEN` to the Codex step unless you explicitly want a fully autonomous agent (treat prompt-injection as a first-class threat).
- IMPORTANT: GitHub App installation tokens expire after ~1 hour. If you expect long-running jobs (up to 6 hours), plan for token refresh (see “Full Access Mode” below).

## GitHub Actions Workflow Spec (`compute.yml` entry)

The kernel dispatches GitHub Actions plugins via `workflow_dispatch`. The default entrypoint workflow is `compute.yml` (unless a workflow id is explicitly specified in config via `owner/repo:workflow.yml`).

Config examples should use `owner/repo` (defaults to `compute.yml`).

### Inputs

Workflow must accept exactly the kernel `workflow_dispatch` inputs:

- `stateId`, `eventName`, `eventPayload`, `settings`, `authToken`, `ref`, `signature`, `command`

### Permissions

Prefer minimal `permissions:` (use `inputs.authToken` for API calls), but ensure the workflow can:

- Read/write contents (for pushing a branch)
- Create PRs and issue comments

If using only installation token for all GitHub operations, the workflow’s `permissions` mostly affect `GITHUB_TOKEN`; still set something conservative like:

```yml
permissions:
  contents: read
```

and rely on `inputs.authToken` for write operations.

## Full Access Mode (Autonomous Agent)

If you want Codex to behave like a “CI coding agent” with full access to the runner, configure the workflow so Codex can run arbitrary commands and talk to GitHub directly.

Recommended knobs:

- Run `codex exec` with `--sandbox danger-full-access` (enables outbound network and unrestricted filesystem access on the runner).
- Provide GitHub auth to Codex **only if needed**:
  - `env: GH_TOKEN: ${{ inputs.authToken }}` (and/or `GITHUB_TOKEN`)
  - Codex can then use `gh` and `git` to create branches/PRs/comments itself.

Hardening note:

- If you want runner-level hardening like “drop sudo”, `openai/codex-action` supports `safety-strategy` — but it’s primarily designed for API-key auth. Subscription-auth runs should rely on sandboxing plus strict token minimization.

Token lifetime caveat (critical):

- `inputs.authToken` (GitHub App installation token) expires after ~1 hour.
- If Codex must access GitHub after that, you need a renewable mechanism:
  - Provide GitHub App credentials (`APP_ID`, `APP_PRIVATE_KEY`) and a small helper script to mint fresh installation tokens on demand, OR
  - Keep GitHub write operations outside the Codex step and mint a fresh token “just-in-time” for PR/commenting in later workflow steps.

### Recommended job outline

1. Decompress `eventPayload`
   - Use `ubiquity-os/compress-action@main` (already used by other plugins)
2. Parse `settings` and `command`
3. Authorization checks
4. Confirm explicit invocation (`/codex` or `@ubiquityos codex`); extract `task`
5. Determine target context
   - Issue vs PR
   - For PR: fetch PR details; deny forks if configured
6. Checkout target repo (fetch-depth 0)
7. Create working branch
8. Install Codex CLI + resolve auth
   - `actions/setup-node` then `npm i -g @openai/codex@<pinned>`
   - Restore subscription auth: write `${CODEX_AUTH_JSON_B64}` → `${CODEX_HOME}/auth.json`, then `codex login status`
   - If auth missing/invalid, comment back with refresh instructions and stop
   - Optional fallback: if `OPENAI_API_KEY` is present, run `printenv OPENAI_API_KEY | codex login --with-api-key`
9. Run Codex (`codex exec`)
   - `codex -a never exec --sandbox <mode> --json - < .codex.prompt.txt | tee .codex.events.jsonl`
   - `--output-last-message .codex.last-message.md` for summary capture
10. Handle failures (especially auth)
   - If `codex exec` fails, scan `.codex.events.jsonl` for `401 Unauthorized` / `403 Forbidden` / `Not logged in`
   - If matched: comment “auth expired/invalid; refresh `CODEX_AUTH_JSON_B64`”
   - Else: comment a short failure summary + workflow logs URL
11. If no diff (`git diff --name-only` empty), comment and exit
12. Commit + push branch
13. Create/update PR
14. Comment back with PR link + summary

### Proposed plugin repository layout

Prefer a single workflow entrypoint at `.github/workflows/compute.yml`:

```
command-codex/
  manifest.json
  README.md
  .github/workflows/compute.yml
  # optional (if bash becomes too complex)
  package.json
  tsconfig.json
  src/
    main.ts
    github.ts
    parse.ts
    prompt.ts
```

Two viable implementation styles:

1. **YAML + `gh` + `jq` only** (closest to `command-ask`): simplest repo, fastest to ship.
2. **YAML orchestrates, Node/Bun does logic**: better ergonomics for parsing/templating and GitHub API calls.

### Workflow architecture (aligned with existing plugins)

Pattern to copy (from existing marketplace plugins):

- `.github/workflows/compute.yml` declares the `workflow_dispatch` inputs and runs the steps directly: decompress payload, checkout target repo with `inputs.authToken` + `persist-credentials: false`, run Codex, then PR/comment.
- Use GitHub Actions **environments** (`development` vs `main`) for secrets.

Key additional considerations for Codex:

- Run `codex` in the checked-out target repo directory.
- Do **not** pass GitHub tokens into the Codex step unless required.
- Create PR + comments in later steps using `inputs.authToken` (as `GH_TOKEN`) once Codex completes.

## Prompt Construction (what we pass to Codex)

Codex should receive a structured prompt that includes:

- Repo identity: `owner/repo`
- Issue/PR number and link
- Issue/PR title + body (truncate safely)
- The triggering comment body
- The parsed `task` (from command args and/or the comment body)
- Optional repo guidance from `AGENTS.md` (Codex automatically discovers/merges it when present in the checked-out repo)
- Explicit constraints:
  - Do not access or print secrets
  - Do not modify CI secrets or workflows unless requested
  - Prefer minimal, focused diffs
  - Run `testCommand` only if configured

Example (conceptual):

```
You are working in the repository OWNER/REPO.
Task: <task>

Context:
- Issue #123: <title>
- Description: <body>
- Trigger comment: <comment body>

Constraints:
- Do not reveal secrets or tokens.
- Keep changes minimal and relevant to the task.
- If tests are configured, run them and include results.

Deliverable:
- Produce a patch that implements the task.
- Summarize changes in 5 bullets.
```

## Authorization & Abuse Prevention

The plugin MUST refuse to run agentic coding for untrusted actors by default.

Minimum checks:

- `payload.comment.user.type === "User"`
- `payload.comment.author_association` in `allowedAuthorAssociations`
- `requireExplicitInvocation === true` implies: comment must clearly contain `/codex` or `@ubiquityos codex`
- If PR context and `denyForkPRs`:
  - Ensure `pull_request.head.repo.full_name === pull_request.base.repo.full_name`

Recommended additional checks:

- Verify permission level via API (`repos.getCollaboratorPermissionLevel`) when available.
- Optional repo allowlist.

Rejection behavior:

- Post a short comment explaining the policy and how to request access.
- Do not run Codex if rejected.

## Error Handling & Recovery

- If Codex fails:
  - Post a comment with a short failure summary and link to logs (workflow run URL).
- If no changes are produced:
  - Post a “no diff produced” comment, suggest refining the task.
- Always include `stateId` in logs and (optionally) in comments for traceability.

## Observability

- Use structured log grouping in Actions.
- Add a GitHub Actions summary section:
  - Task
  - Outcome (PR link / rejected / no diff)
  - Files changed (from `git diff --name-only`)
  - Test results (if run)

## Implementation Plan

1. Scaffold `ubiquity-os-marketplace/command-codex`
   - Add `manifest.json` with `commands.codex`
   - Add `.github/workflows/compute.yml` matching kernel inputs
   - Add `README.md` documenting usage and restrictions
2. Add secrets to plugin repo environments
   - `CODEX_AUTH_JSON_B64` in `development` and `main`
   - Optional fallback: `OPENAI_API_KEY`
3. Ship “comment-only” MVP (fast feedback loop)
   - Decompress payload, enforce auth + explicit invocation, run `codex exec`, comment a short summary
4. Add PR mode
   - Create branch, commit changes, push, create PR, comment link back
   - If no changes, comment and exit cleanly
5. Add safety hardening
   - Ensure Codex step has no GitHub tokens in env
   - Deny fork PR contexts by default
   - Add basic allowlist/role checks

## Test Plan (end-to-end)

1. In a test repo where the kernel App is installed, enable the plugin in `.github/.ubiquity-os.config.dev.yml`:
   - `ubiquity-os-marketplace/command-codex:`
2. Ensure the plugin repo has `CODEX_AUTH_JSON_B64` set in the `development` environment (optional fallback: `OPENAI_API_KEY`).
3. Post a comment on an issue: `/codex add a small file named TEST.txt with the word hello`
4. Verify:
   - A `workflow_dispatch` run starts in the plugin repo
   - A branch + PR is created (or “no diff” comment is posted)
   - A comment is posted back on the original issue with the outcome and PR link

## Acceptance Criteria

- A user can invoke `/codex <task>` (or `@ubiquityos codex <task>`) and receive a PR link with changes.
- Only users with `author_association` in `allowedAuthorAssociations` can trigger a run.
- The plugin checks out the target repo using `inputs.authToken` (not `GITHUB_TOKEN`).
- Secrets (`CODEX_AUTH_JSON_B64`, `OPENAI_API_KEY` if used, `inputs.authToken`) are not printed in logs and are masked.
- If Codex subscription auth is missing/expired, the plugin comments back with steps to refresh `CODEX_AUTH_JSON_B64`.
- If Codex produces no diff, the plugin comments a clear “no changes” outcome.
- Fork PRs are denied by default (configurable).

## Implementation Checklist (plugin repo)

Files to create in `ubiquity-os-marketplace/command-codex`:

- `manifest.json`
  - Defines `commands.codex`
  - Defines `configuration` schema for `with:` settings
- `.github/workflows/compute.yml`
  - `workflow_dispatch` inputs compatible with kernel
  - Implements the flow above
- `README.md`
  - Documents `/codex` usage and safety constraints
- `src/` (optional but recommended)
  - Small Node/Bun scripts for:
    - parsing inputs safely
    - authorization checks
    - PR creation/commenting via Octokit
    - building Codex prompt

Kernel/org config change (in `.ubiquity-os` repo):

- `.github/.ubiquity-os.config.yml` and/or `.github/.ubiquity-os.config.dev.yml`
  - Add plugin entry:
    - `ubiquity-os-marketplace/command-codex:`
      - `with:` defaults + policy overrides

## Open Questions

- Should `/codex` update an existing open PR for the same issue if one exists, or always create a new PR?
- Do we want an explicit “dry run” mode that only comments a plan/review?
- Should we support a two-step approval flow for external contributors (request → maintainer approves)?
- Should we integrate with existing label/assignment workflow (e.g., require `Priority:` label before allowing `/codex`)?
