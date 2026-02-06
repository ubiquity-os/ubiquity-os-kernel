# Telegram Guest Mode (Telegram-Only Personal Assistant)

This folder is a handoff spec for implementing a **Telegram-only guest tier** (no GitHub account required) while preserving the existing GitHub-linked mode.

## Docs Index

- `docs/architecture/telegram-guest/00-overview.md`
- `docs/architecture/telegram-guest/01-contracts.md` (read first; freezes interfaces so work can parallelize)
- `docs/architecture/telegram-guest/02-kernel-guest-ingress.md`
- `docs/architecture/telegram-guest/03-kv-storage.md`
- `docs/architecture/telegram-guest/04-memory-service.md`
- `docs/architecture/telegram-guest/05-telegram-plugins.md`
- `docs/architecture/telegram-guest/06-security-privacy.md`
- `docs/architecture/telegram-guest/07-observability-limits.md`
- `docs/architecture/telegram-guest/08-rollout-migration.md`
- `docs/architecture/telegram-guest/09-orchestration-worktrees.md`

## Key Principle

**Contracts first.** The main integration risk is having multiple agents implement incompatible payload formats (KV records, memory search API, plugin invocation API).

Before any implementation work starts, lock `docs/architecture/telegram-guest/01-contracts.md` in a commit. All agents should treat it as source of truth.

