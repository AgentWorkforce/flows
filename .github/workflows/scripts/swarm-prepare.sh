#!/bin/sh
# Fetch PR evidence where GitHub authentication exists and stage it for upload.
set -eu

pr_number=${1:?usage: swarm-prepare.sh PR_NUMBER}
case "$pr_number" in *[!0-9]*|'') echo "invalid PR number: $pr_number" >&2; exit 1 ;; esac

mkdir -p .review-target
printf '%s\n' "$pr_number" > .review-target/pr-number
gh pr diff "$pr_number" > .review-target/pr.diff
gh pr view "$pr_number" --json headRefName,headRefOid,title,url > .review-target/pr.json
touch .review-target/sync-start
git add -f .review-target/pr-number .review-target/pr.diff \
  .review-target/pr.json .review-target/sync-start
