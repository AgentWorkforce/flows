#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: swarm-prepare.sh <gate-tree> <target-tree> <pr-number>" >&2
  exit 2
}

[ "$#" -eq 3 ] || usage
gate_tree=$1
target_tree=$2
pr_number=$3
case "$pr_number" in (*[!0-9]*|'') usage ;; esac

mkdir -p "$target_tree/.review-target" \
  "$target_tree/.github/workflows/scripts"
gh pr view "$pr_number" --json headRefName,headRefOid,title,url \
  > "$target_tree/.review-target/pr.json"
gh pr diff "$pr_number" > "$target_tree/.review-target/pr.diff"
printf '%s\n' "$pr_number" > "$target_tree/.review-target/pr-number"

# The target branch supplies the code under review; main supplies its judge.
cp "$gate_tree/workflows/review-swarm.yaml" \
  "$target_tree/workflows/review-swarm.yaml"
cp "$gate_tree/.github/workflows/scripts/swarm-post.sh" \
  "$target_tree/.github/workflows/scripts/swarm-post.sh"

git -C "$target_tree" add -f \
  .review-target/pr-number \
  .review-target/pr.diff \
  .review-target/pr.json \
  workflows/review-swarm.yaml \
  .github/workflows/scripts/swarm-post.sh
