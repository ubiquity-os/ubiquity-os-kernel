# Rollout and Migration Plan

## Goals

- Ship guest DM assistant incrementally without destabilizing GitHub-linked mode.
- Keep the guest data plane isolated from GitHub data plane.
- Enable future expansion (topics/workspaces, linked mode upgrades) without breaking contracts.

## Rollout Phases

### Phase 1: Guest DM Chat (KV Only)

- Unlinked DM users can chat and receive replies.
- Persist transcript in KV.
- No memory service, no plugins yet.

Success criteria:
- user can send messages, get replies reliably
- KV transcript survives restarts

### Phase 2: Memory Service Integration

- Index inbound/outbound messages (async best-effort).
- Retrieve memory matches for prompt augmentation (sync with short timeout).

Success criteria:
- semantic recall improves responses
- no cross-tenant leakage

### Phase 3: Telegram Plugin Framework

- Introduce plugin catalog (small allowlist).
- Router can choose plugins (prompt-driven).
- Provide `/help` and explicit slash command invocation if desired.

Success criteria:
- at least 2 functional plugins (e.g., notes + tasks)
- stable dispatch and response formatting

### Phase 4: Hardening

- per-workspace quotas
- better observability and dashboards
- user export/delete endpoints (even if retention default is forever)

## Preserving Linked Mode

Rule:
- If Telegram user is linked to a GitHub owner, keep the current GitHub-shaped pipeline unchanged.

Guest mode triggers only when:
- chat is DM/private AND
- user is not linked

## Configuration Strategy (No New Env Vars in MVP)

MVP:
- guest plugin allowlist hardcoded in code (small and stable)
- memory service URL hardcoded (or set via existing config plumbing if already available)

Later (preferred):
- store guest plugin list + memory service URL in KV as admin-managed config
- avoid introducing new env var keys unless explicitly approved

## Future: Topics/Workspaces

After DM MVP is stable:
- allow optional user-created "contexts" (topics)

This requires decisions:
- are topics separate conversations within a workspace?
- do topics have separate memory scopes or share workspace memory?

If adding topics later:
- extend `conversationId` to include topic IDs
- keep `workspaceId` as the tenant boundary

Do not change `workspaceId` semantics after launch.

