# Orchestration: Worktrees + Parallel Codex Agents

This doc describes how to spin up multiple Codex agents to implement guest mode concurrently using **separate git worktrees**.

## Why Worktrees

Worktrees ensure:
- each agent has an isolated checkout
- each agent can commit freely to its own branch
- merges are explicit and can be handled by a dedicated merge agent

## Scripts

Scripts live under:

- `scripts/telegram-guest/bootstrap-worktrees.sh`
- `scripts/telegram-guest/run-agents.sh`
- `scripts/telegram-guest/merge-branches.sh`

Local-only output:
- worktrees are created under `.worktrees/telegram-guest/` (gitignored)
- agent logs written under `.codex-agent-logs/` (gitignored)

## Recommended Agent Split

1. `contracts` (human/orchestrator): finalize `01-contracts.md` and commit it.
2. `kernel-guest-ingress`: implement guest DM pipeline in kernel.
3. `memory-service`: implement memory service and schema.
4. `telegram-plugins`: implement plugin framework + starter plugins.
5. `security-privacy`: implement signature verification + quotas.
6. `merge-agent`: merge branches and resolve conflicts.

## Execution

### 1) Create Worktrees

```bash
bash scripts/telegram-guest/bootstrap-worktrees.sh
```

### 2) Run Agents (Parallel)

```bash
bash scripts/telegram-guest/run-agents.sh
```

This will:
- start one `codex exec` process per worktree
- each agent reads its spec under `docs/architecture/telegram-guest/`
- each agent commits to its own branch

### 3) Merge

```bash
bash scripts/telegram-guest/merge-branches.sh
```

Merging is intentionally separated because conflicts are expected.

## Notes

- If you change contracts mid-flight, expect rework. Prefer freezing `01-contracts.md` first.
- If an agent produces a partial result, rerun that specific agent by invoking `codex exec` in its worktree.

