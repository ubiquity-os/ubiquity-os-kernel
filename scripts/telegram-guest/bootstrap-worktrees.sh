#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

BASE_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
WORKTREE_ROOT="$REPO_ROOT/.worktrees/telegram-guest"

mkdir -p "$WORKTREE_ROOT"

declare -a SPECS=(
  "kernel|telegram-guest/kernel|$WORKTREE_ROOT/kernel"
  "memory|telegram-guest/memory-service|$WORKTREE_ROOT/memory"
  "plugins|telegram-guest/telegram-plugins|$WORKTREE_ROOT/plugins"
  "security|telegram-guest/security-privacy|$WORKTREE_ROOT/security"
  "merge|telegram-guest/integration|$WORKTREE_ROOT/merge"
)

branch_exists() {
  git show-ref --verify --quiet "refs/heads/$1"
}

worktree_exists() {
  git worktree list --porcelain | rg -n --fixed-strings "worktree $1" >/dev/null 2>&1
}

echo "Repo: $REPO_ROOT"
echo "Base branch: $BASE_BRANCH"
echo "Worktree root: $WORKTREE_ROOT"
echo

if ! command -v rg >/dev/null 2>&1; then
  # fall back to grep if ripgrep isn't installed
  worktree_exists() {
    git worktree list --porcelain | grep -F "worktree $1" >/dev/null 2>&1
  }
fi

for spec in "${SPECS[@]}"; do
  IFS="|" read -r name branch path <<<"$spec"

  if worktree_exists "$path"; then
    echo "Worktree already exists: $name -> $path ($branch)"
    continue
  fi

  if [[ -e "$path" ]]; then
    echo "ERROR: Path exists but is not registered as a worktree: $path" >&2
    echo "Refusing to overwrite. Move/delete it manually, then rerun." >&2
    exit 1
  fi

  if branch_exists "$branch"; then
    echo "Adding worktree: $name -> $path (existing branch $branch)"
    git worktree add "$path" "$branch"
  else
    echo "Adding worktree: $name -> $path (new branch $branch from $BASE_BRANCH)"
    git worktree add -b "$branch" "$path" "$BASE_BRANCH"
  fi
done

echo
echo "Done."
echo "Next:"
echo "  bash scripts/telegram-guest/run-agents.sh"

