# `telegram-ingress` -- Telegram DM interface for the kernel

Status: Draft  
Last updated: 2025-12-19

## Summary

Add a Telegram DM ingress that mirrors the GitHub comment experience: slash commands and plain text conversation routed via the existing command router. Users link their Telegram identity to GitHub using an existing GitHub App login flow, then select a repo context. The kernel loads the repo configuration and dispatches plugins as usual, but replies are delivered to Telegram instead of GitHub comments. Deploy on Deno Deploy and use Deno KV for state.

## Goals

- Provide a private Telegram DM interface with slash commands and natural language routing.
- Use GitHub App OAuth login for identity linking (avoid public GitHub comment linking).
- Allow per-user context selection (org/repo, optional issue/PR).
- Reuse kernel config and plugin dispatch with minimal plugin changes.
- Support plugin replies back into Telegram without GitHub comment noise.
- Use Deno KV for simple state and router context.

## Non-goals

- Group chats, channels, or multi-user threads.
- A Telegram Mini App UI.
- Long-term chat history storage or analytics (beyond short router context).
- Regex/keyword heuristics for AI decisions (LLM routing only).

## Current kernel behavior (reference)

- GitHub webhook ingress in `src/kernel.ts`.
- Slash commands are resolved in `src/github/handlers/issue-comment-created.ts` by scanning manifests and dispatching plugins via `dispatchWorker` or `dispatchWorkflow`.
- Plain text mentions use `commandRouter` + `callUbqAiRouter`.
- Plugins generally reply via `CommentHandler` (GitHub comments).

## User experience (Telegram DM)

### Onboarding and linking

1. User sends `/start` or `/link`.
2. Bot replies with a GitHub App login link that contains a one-time token.
3. Login service completes OAuth and calls back to the kernel to complete linking.
4. Bot confirms linkage and prompts for repo context.

### Context selection

- `/context owner/repo` sets the active repo (validated via GitHub App).
- `/issue <url|number>` optionally sets active issue/PR for issue-bound commands.
- `/context` shows current context and recent repos.

### Slash commands

- `/help` lists available commands for the active repo.
- `/wallet ...` and other commands behave like GitHub but reply in Telegram.
- Commands should also accept `/command@botname` formats.

### Plain text conversation

- Any non-slash message in DM is treated as a mention-equivalent.
- Kernel uses the same router logic as GitHub (LLM decides reply/command/agent).
- Replies come back as Telegram messages.

### Error UX

- Unlinked user: prompt to link.
- No context: prompt to set `/context`.
- Missing issue for issue-bound command: prompt to set `/issue`.

## Architecture overview

### Ingress (Telegram)

- Add `POST /telegram/webhook` in Hono.
- Validate `X-Telegram-Bot-Api-Secret-Token`.
- Accept only private chats (`chat.type === "private"`).
- Limit `allowed_updates` to `message,callback_query`.

### Identity and linking (GitHub App OAuth)

- Telegram `/link` creates a one-time token stored in KV with TTL (for example 10 min).
- Bot sends `https://<login-service>/telegram/link?token=...`.
- Login service completes GitHub App OAuth and POSTs to `POST /telegram/link/complete` with token + GitHub user info.
- Kernel resolves the token, links Telegram user to GitHub user id/login, and stores record in KV.

### Context and config resolution

- For an active repo, resolve installation id using GitHub App credentials.
- Load config using existing logic, but decouple it from a GitHub webhook payload.
- Store per-user context in KV:
  - active owner/repo
  - optional issue/PR
  - last command timestamp (for rate limits)

### Routing and dispatch

- If message starts with `/`, parse slash command and dispatch as today.
- Otherwise, use router logic:
  - Build `describeCommands` list from manifests.
  - Provide recent Telegram messages as context (not GitHub comments).
  - Use LLM to decide `reply`, `command`, `agent`, `help`, or `ignore`.
- Dispatch reuses `PluginInput` and `dispatchWorker` / `dispatchWorkflow`.

### Reply channel (Telegram)

Problem: plugins currently post GitHub comments.

Approach:

- Add optional `reply` to plugin inputs:
  - `reply.channel = "telegram"`
  - `reply.target = { chatId, messageId }`
  - `reply.kernelBaseUrl` or `reply.endpoint`
- Update `lib/plugin-sdk/src/comment.ts`:
  - If `reply.channel === "telegram"`, call `POST /telegram/reply`.
  - Else keep GitHub comment behavior.
- Add `POST /telegram/reply` to kernel:
  - Verify signature/attestation.
  - Send message via Telegram API.

This allows existing plugins (for example `/wallet`) to reply into Telegram without per-plugin changes.

### Synthetic event payload

- For compatibility, dispatch as `issue_comment.created` with a synthetic payload:
  - `repository.owner.login`, `repository.name`
  - `sender.id`, `sender.login` from linked GitHub user
  - `comment.body` from Telegram message
  - If active issue is set, include issue fields; otherwise minimal payload
- For issue-bound commands, require `activeIssue` or prompt the user.

### Storage (Deno KV)

Primary store for:

- Link tokens
- Linked user records
- Active context
- Recent chat history for router

Supabase remains optional for analytics or longer-term audit data.

### Security and rate limits

- Validate Telegram secret header and optionally IP allowlist.
- One-time link tokens with TTL and single-use.
- Store minimal PII (Telegram id, GitHub id/login).
- Per-chat rate limiting for router and dispatch.
- Use GitHub App installation tokens, never PATs.

### Deployment (Deno Deploy)

- Add env vars:
  - `TELEGRAM_BOT_TOKEN`
  - `TELEGRAM_WEBHOOK_SECRET`
  - `TELEGRAM_WEBHOOK_URL`
- Use Deno KV for state.
- Provide a helper script or manual steps to call `setWebhook`.

## Data model (Deno KV)

- `["telegram", "link", <token>] -> { telegramUserId, chatId, createdAt }` (TTL 10 min)
- `["telegram", "user", <telegramUserId>] -> { chatId, githubId, githubLogin, linkedAt, activeRepo, activeIssue }`
- `["telegram", "history", <telegramUserId>, <timestamp>, <messageId>] -> { role, text }` (keep last N)
- Optional cache:
  - `["github", "repo", <owner>, <repo>, "installationId"] -> { id, cachedAt }`

## New API surface (kernel)

- `POST /telegram/webhook` - Telegram updates ingress
- `POST /telegram/link/complete` - OAuth callback from login service
- `POST /telegram/reply` - plugin reply bridge
- `GET /telegram/health` (optional)

## Implementation phases

### Phase 1: Ingress + identity + context

- Add Telegram webhook handler.
- Implement link flow via GitHub App login.
- Add KV store for user linkage and context.
- Implement `/context`, `/issue`, `/help`, `/whoami`.

### Phase 2: Command dispatch + reply bridge

- Add slash command parsing and dispatch using manifest scan.
- Add `reply` support in `PluginInput` and plugin SDK `CommentHandler`.
- Add kernel `POST /telegram/reply`.

### Phase 3: Plain text router

- Add Telegram router prompt and decision handling.
- Store recent Telegram messages in KV for context.
- Support `reply`, `command`, `agent`, `help` actions.

## Testing plan

- Unit tests for:
  - Telegram update parsing
  - Link token lifecycle
  - Context validation
  - Router input shaping
- Integration tests:
  - Webhook validation with secret token
  - Reply bridge calls from plugin SDK
- Manual E2E:
  - Link account, set context, run `/wallet`, send plain text request.

## Open questions

- What is the canonical GitHub App login URL to use for link flow?
- Should we store GitHub OAuth user tokens, or only user id/login?
- Which commands are safe and useful in DM without issue context?
- Do we need a default issue per repo for certain commands?
- Should `agent` be allowed in Telegram DM by default?

## Files to touch (planned)

- `src/kernel.ts` (Telegram routes)
- `src/telegram/*` (new modules: handler, auth, state, router)
- `src/github/utils/config.ts` (extract repo-based config loader)
- `src/github/handlers/issue-comment-created.ts` (reuse router prompt/describeCommands)
- `lib/plugin-sdk/src/types/input-schema.ts` (add `reply` shape)
- `lib/plugin-sdk/src/comment.ts` (reply channel)
- `lib/plugin-sdk/src/server.ts` (thread reply data into context)
- `specs/telegram-ingress.md` (this document)

## References

- Telegram Bot API and webhooks: https://core.telegram.org/bots/api
- Webhook secret token: https://core.telegram.org/bots/api#setwebhook
- GitHub Apps vs OAuth Apps: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps
