#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if ! command -v codex >/dev/null 2>&1; then
  echo "ERROR: codex CLI not found in PATH." >&2
  exit 1
fi

WORKTREE_ROOT="$REPO_ROOT/.worktrees/telegram-guest"
LOG_ROOT="$REPO_ROOT/.codex-agent-logs/telegram-guest"
mkdir -p "$LOG_ROOT"

declare -A WORKTREES=(
  ["kernel"]="$WORKTREE_ROOT/kernel"
  ["memory"]="$WORKTREE_ROOT/memory"
  ["plugins"]="$WORKTREE_ROOT/plugins"
  ["security"]="$WORKTREE_ROOT/security"
)

declare -A SPECS=(
  ["kernel"]="docs/architecture/telegram-guest/02-kernel-guest-ingress.md"
  ["memory"]="docs/architecture/telegram-guest/04-memory-service.md"
  ["plugins"]="docs/architecture/telegram-guest/05-telegram-plugins.md"
  ["security"]="docs/architecture/telegram-guest/06-security-privacy.md"
)

usage() {
  cat <<'EOF'
Usage:
  bash scripts/telegram-guest/run-agents.sh [kernel memory plugins security]

If no args are provided, all agents run in parallel.
EOF
}

AGENTS=("$@")
if [[ "${#AGENTS[@]}" -eq 0 ]]; then
  AGENTS=("kernel" "memory" "plugins" "security")
fi

for agent in "${AGENTS[@]}"; do
  if [[ -z "${WORKTREES[$agent]:-}" ]]; then
    echo "Unknown agent: $agent" >&2
    usage >&2
    exit 2
  fi
  if [[ ! -d "${WORKTREES[$agent]}" ]]; then
    echo "Missing worktree directory for agent '$agent': ${WORKTREES[$agent]}" >&2
    echo "Run: bash scripts/telegram-guest/bootstrap-worktrees.sh" >&2
    exit 2
  fi
done

run_agent() {
  local agent="$1"
  local workdir="${WORKTREES[$agent]}"
  local spec="${SPECS[$agent]}"
  local log="$LOG_ROOT/$agent.log"
  local last="$LOG_ROOT/$agent.last.txt"

  cat <<EOF | codex exec --full-auto --cd "$workdir" -o "$last" - >"$log" 2>&1 &
You are a scoped implementation agent working in an isolated git worktree.

Read these specs first:
- docs/architecture/telegram-guest/01-contracts.md
- ${spec}

Hard constraints:
- Do NOT change docs/architecture/telegram-guest/01-contracts.md unless absolutely necessary. If you think a contract change is required, stop and explain why in your final message instead of editing it.
- Do NOT introduce new environment variable keys.
- Preserve existing GitHub-linked Telegram behavior.
- Keep changes tightly scoped to your area to minimize merge conflicts.

Output expectations:
- Implement the spec in this worktree.
- Add/adjust tests where appropriate.
- Run the relevant test command(s).
- Make one or more git commits on your branch with clear messages.
- In your final message, include:
  - what you changed (files)
  - how you tested
  - any follow-ups / known gaps
EOF

  echo "Started agent '$agent' (log: $log)"
}

echo "Logs: $LOG_ROOT"
echo

for agent in "${AGENTS[@]}"; do
  run_agent "$agent"
done

echo
echo "Waiting for agents to finish..."
wait

echo
echo "All agents finished."
echo "Review logs under: $LOG_ROOT"
echo "Next: bash scripts/telegram-guest/merge-branches.sh"

