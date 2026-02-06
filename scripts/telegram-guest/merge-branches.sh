#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
MERGE_WORKTREE="$REPO_ROOT/.worktrees/telegram-guest/merge"

declare -a BRANCHES=(
  "telegram-guest/kernel"
  "telegram-guest/memory-service"
  "telegram-guest/telegram-plugins"
  "telegram-guest/security-privacy"
)

if [[ ! -d "$MERGE_WORKTREE" ]]; then
  echo "Missing merge worktree: $MERGE_WORKTREE" >&2
  echo "Run: bash scripts/telegram-guest/bootstrap-worktrees.sh" >&2
  exit 2
fi

cd "$MERGE_WORKTREE"

echo "Merge worktree: $MERGE_WORKTREE"
echo "Current branch: $(git rev-parse --abbrev-ref HEAD)"
echo

if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: merge worktree is dirty. Resolve/stash changes first." >&2
  git status --porcelain >&2
  exit 1
fi

for branch in "${BRANCHES[@]}"; do
  echo "Merging $branch ..."
  if ! git merge --no-edit "$branch"; then
    echo
    echo "Merge conflict while merging $branch."
    echo "Resolve conflicts in: $MERGE_WORKTREE"
    echo
    echo "Suggested next step (merge agent):"
    echo "  cd \"$MERGE_WORKTREE\""
    echo "  codex exec --full-auto \"Resolve the current git merge conflicts, complete the merge, run tests, and summarize.\""
    exit 1
  fi
done

echo
echo "All branches merged cleanly into $(git rev-parse --abbrev-ref HEAD)."
echo "Run tests in the merge worktree, then push the integration branch."

