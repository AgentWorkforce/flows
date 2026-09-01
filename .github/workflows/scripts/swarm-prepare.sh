#!/bin/sh
# Fetch the review target on the authenticated GHA runner, then track it so
# agent-relay's working-tree upload carries it into the unauthenticated sandbox.
set -eu

repo_dir=${1:?usage: swarm-prepare.sh REPO_DIR PR_NUMBER}
pr_number=${2:?usage: swarm-prepare.sh REPO_DIR PR_NUMBER}
target_dir=$repo_dir/.review-target

case "$pr_number" in *[!0-9]*|'') echo "invalid PR number: $pr_number" >&2; exit 64;; esac

mkdir -p "$target_dir"
printf '%s\n' "$pr_number" > "$target_dir/pr-number"
date +%s > "$target_dir/started-at"
gh pr diff "$pr_number" > "$target_dir/pr.diff"
gh pr view "$pr_number" --json number,headRefName,headRefOid,title,url,author \
  > "$target_dir/pr.json"
git -C "$repo_dir" add -f .review-target/pr-number .review-target/started-at \
  .review-target/pr.diff .review-target/pr.json

git -C "$repo_dir" ls-files --error-unmatch .review-target/pr-number \
  .review-target/started-at .review-target/pr.diff .review-target/pr.json >/dev/null
echo "prepared PR #$pr_number for cloud upload"
