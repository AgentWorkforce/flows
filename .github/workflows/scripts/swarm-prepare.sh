#!/usr/bin/env bash
set -euo pipefail

gate_dir=${1:?trusted gate checkout required}
target_dir=${2:?review target checkout required}
: "${PR_NUMBER:?PR_NUMBER is required}"

mkdir -p "$target_dir/.review-gate" "$target_dir/.review-target"
cp "$gate_dir/workflows/review-swarm.yaml" "$target_dir/.review-gate/review-swarm.yaml"
cp "$gate_dir/.github/workflows/scripts/swarm-post.sh" "$target_dir/.review-gate/swarm-post.sh"
chmod +x "$target_dir/.review-gate/swarm-post.sh"

printf '%s\n' "$PR_NUMBER" > "$target_dir/.review-target/pr-number"
gh pr diff "$PR_NUMBER" > "$target_dir/.review-target/pr.diff"
gh pr view "$PR_NUMBER" --json headRefName,headRefOid,title,url > "$target_dir/.review-target/pr.json"

# cloud run uploads tracked files; force-stage the trusted gate and fetched input.
git -C "$target_dir" add -f .review-gate .review-target
