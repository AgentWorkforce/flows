#!/bin/sh
set -eu

worktree=${1:-.}
gate_script=${2:-}
: "${PR_NUMBER:?PR_NUMBER is required}"
: "${GH_REPO:?GH_REPO is required}"

case "$PR_NUMBER" in
  *[!0-9]*|'') echo "PR_NUMBER must be numeric" >&2; exit 64 ;;
esac

mkdir -p "$worktree/.review-target"
if [ -z "$gate_script" ] || [ ! -f "$gate_script" ]; then
  echo "immutable swarm-post.sh is required" >&2
  exit 64
fi
mkdir -p "$worktree/.github/workflows/scripts"
cp "$gate_script" "$worktree/.github/workflows/scripts/swarm-post.sh"
printf '%s\n' "$PR_NUMBER" > "$worktree/.review-target/pr-number"
gh pr diff "$PR_NUMBER" --repo "$GH_REPO" > "$worktree/.review-target/pr.diff"
gh pr view "$PR_NUMBER" --repo "$GH_REPO" \
  --json headRefName,headRefOid,title,url > "$worktree/.review-target/pr.json"

git -C "$worktree" add -f .review-target/pr-number \
  .review-target/pr.diff .review-target/pr.json \
  .github/workflows/scripts/swarm-post.sh
git -C "$worktree" ls-files --error-unmatch \
  .review-target/pr-number .review-target/pr.diff .review-target/pr.json \
  .github/workflows/scripts/swarm-post.sh >/dev/null
