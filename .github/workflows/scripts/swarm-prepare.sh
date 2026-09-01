#!/usr/bin/env bash
set -euo pipefail

target=${1:?usage: swarm-prepare.sh TARGET_DIR GATE_DIR}
gate=${2:?usage: swarm-prepare.sh TARGET_DIR GATE_DIR}
: "${PR_NUMBER:?PR_NUMBER is required}"

case "$PR_NUMBER" in
  *[!0-9]*|'') echo "PR_NUMBER must be numeric" >&2; exit 1 ;;
esac

mkdir -p "$target/.review-target" "$target/.review-gate"
printf '%s\n' "$PR_NUMBER" > "$target/.review-target/pr-number"
gh pr diff "$PR_NUMBER" > "$target/.review-target/pr.diff"
gh pr view "$PR_NUMBER" --json headRefName,headRefOid,title,url > "$target/.review-target/pr.json"
date +%s > "$target/.review-target/sync-started"
cp "$gate/.github/workflows/scripts/swarm-post.sh" "$target/.review-gate/swarm-post.sh"
chmod +x "$target/.review-gate/swarm-post.sh"

git -C "$target" add -f .review-target .review-gate/swarm-post.sh
