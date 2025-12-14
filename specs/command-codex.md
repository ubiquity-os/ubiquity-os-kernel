# `command-codex` — Codex CLI command plugin (GitHub Actions)

Status: Draft  
Last updated: 2025-12-14

## Summary

Add a new marketplace plugin, `ubiquity-os-marketplace/command-codex`, that allows trusted users to trigger agentic coding via GitHub comments (e.g. `/codex …` or `@ubiquityos …`). The plugin runs on **GitHub Actions**, wraps the **OpenAI Codex CLI** (`codex exec`), applies any produced diff, and returns results by opening/updating a PR and commenting back on the issue/PR.

This is intentionally implemented as a plugin (not in-kernel), so the kernel can stay lightweight and deployment-target agnostic (Deno Deploy, Workers, etc.), while agentic code execution happens in a sandboxed CI runner.

## Background / Existing Kernel Behavior

The kernel already detects and routes:

- Mentions prefixed with `@ubiquityos`
- Slash commands (rewritten to look like a bot mention)

via `src/github/handlers/issue-comment-created.ts`, which calls `commandRouter(context)` for those cases. `commandRouter`:

1. Loads enabled plugins from `.github/.ubiquity-os.config*.yml` (org + repo configs)
2. Fetches each plugin’s `manifest.json`
3. Exposes `manifest.commands` as OpenAI tool definitions
4. Lets an LLM choose a single tool call
5. Dispatches the selected plugin via `workflow_dispatch` (GitHub Actions) or HTTP (Workers)

`command-codex` plugs into this existing command pipeline by defining a `codex` command in its `manifest.json`.

## Goals

- Provide an **agentic “make changes in repo”** capability triggered by a GitHub comment.
- Run in **GitHub Actions** (not in kernel runtime).
- Use **Codex CLI** in non-interactive mode (`codex exec`) to produce a diff and/or edits.
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

Use explicit triggers to remove ambiguity and prevent the kernel LLM from choosing the wrong tool:

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

1. User posts comment `/codex …` or `@ubiquityos …` on an issue/PR.
2. Kernel `issue_comment.created` handler routes into `commandRouter`.
3. Kernel LLM selects the `codex` tool (based on `manifest.commands.codex`).
4. Kernel dispatches `workflow_dispatch` to the plugin repo (`command-codex`), passing:
   - `eventPayload` (compressed JSON of the GitHub event payload)
   - `authToken` (GitHub App installation token minted by kernel)
   - `settings` (plugin config `with:` serialized as JSON)
   - `command` (selected tool name + JSON arguments)
   - `stateId`, `eventName`, `ref`, `signature`, etc.
5. Plugin workflow:
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

Recommended schema:

```json
{
  "type": "object",
  "properties": {
    "task": { "type": "string", "description": "What to implement/change" }
  }
}
```

Important note: the kernel currently treats all `parameters.properties` as required when building tool schemas. To avoid “optional parameter” issues, keep the command schema small (one required string like `task`) and put advanced tuning in plugin `settings` instead.

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

### Codex execution controls

- `model`: `string`
  - Default: omit (Codex CLI default)
  - Passed as `codex exec -m <model>`
- `sandbox`: `"read-only" | "workspace-write" | "danger-full-access"`
  - Default: `"workspace-write"`
  - Passed as `codex exec --sandbox <mode>`
- `askForApproval`: `"untrusted" | "on-failure" | "on-request" | "never"`
  - Default: `"never"` for CI/headless runs
  - Passed as `codex exec -a <policy>`
- `codexProfile`: `string | null`
  - Default: `null`
  - Passed as `codex exec --profile <name>` when set
- `maxRuntimeMinutes`: `number`
  - Default: `20` (enforced by job timeout)

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

Store these in the plugin repo GitHub **Environments** (recommended split: `development` and `main`), or repo secrets:

- `OPENAI_API_KEY` (required): used by Codex CLI.

Optional (only if needed for your org setup):

- `OPENAI_ORG`
- `OPENAI_PROJECT`

### Token/secret handling requirements

- Mask `inputs.authToken` and `OPENAI_API_KEY` immediately (GitHub Actions masking).
- Do not print decompressed payloads that may contain sensitive data.
- Prefer `actions/checkout` with `persist-credentials: false` so credentials aren’t left in `.git/config` during agent execution.
- Only inject a push-capable credential *after* Codex finishes, right before pushing.

## GitHub Actions Workflow Spec (`compute.yml`)

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

### Recommended job outline

1. Decompress `eventPayload`
   - Use `ubiquity-os/compress-action@main` (already used by other plugins)
2. Parse `settings` and `command`
3. Authorization checks
4. Determine target context
   - Issue vs PR
   - For PR: fetch PR details; deny forks if configured
5. Checkout target repo (fetch-depth 0)
6. Create working branch
7. Install Codex CLI
   - `npm install -g @openai/codex`
8. Run Codex
   - Use `codex exec` (non-interactive)
   - Recommended flags for CI:
     - `--sandbox workspace-write`
     - `-a never`
     - `--json` (capture thread/task id + logs)
     - `--output-last-message` (capture final summary)
9. Apply changes
   - Extract `thread_id` from the JSONL output (`type: thread.started`)
   - Run `codex apply <thread_id>`
10. If no diff, comment and exit
11. Commit + push branch
12. Create/update PR
13. Comment back with PR link + summary

## Prompt Construction (what we pass to Codex)

Codex should receive a structured prompt that includes:

- Repo identity: `owner/repo`
- Issue/PR number and link
- Issue/PR title + body (truncate safely)
- The triggering comment body
- The parsed `task` from command parameters
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
- If `codex apply` produces conflicts or can’t apply:
  - Post a comment and stop (do not push partial state).
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

## Acceptance Criteria

- A user can invoke `/codex <task>` (or `@ubiquityos codex <task>`) and receive a PR link with changes.
- Only users with `author_association` in `allowedAuthorAssociations` can trigger a run.
- The plugin checks out the target repo using `inputs.authToken` (not `GITHUB_TOKEN`).
- Secrets (`OPENAI_API_KEY`, `inputs.authToken`) are not printed in logs and are masked.
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
- `src/` (optional but recommended)
  - Small Node/Bun scripts for:
    - parsing inputs safely
    - authorization checks
    - PR creation/commenting via Octokit
    - building Codex prompt

Kernel/org config change (in `.ubiquity-os` repo):

- `.github/.ubiquity-os.config.yml` and/or `.github/.ubiquity-os.config.dev.yml`
  - Add plugin entry:
    - `ubiquity-os-marketplace/command-codex@<ref>:`
      - `with:` defaults + policy overrides

## Open Questions

- Should `/codex` update an existing open PR for the same issue if one exists, or always create a new PR?
- Do we want an explicit “dry run” mode that only comments a plan/review?
- Should we support a two-step approval flow for external contributors (request → maintainer approves)?
- Should we integrate with existing label/assignment workflow (e.g., require `Priority:` label before allowing `/codex`)?

