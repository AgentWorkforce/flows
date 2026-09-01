#!/usr/bin/env bash
set -euo pipefail

pr=${1:?usage: swarm-prepare.sh PR_NUMBER}
case "$pr" in (*[!0-9]*|'') echo "invalid PR number: $pr" >&2; exit 2;; esac

mkdir -p .review-target
printf '%s\n' "$pr" > .review-target/pr-number
gh pr diff "$pr" > .review-target/pr.diff
gh pr view "$pr" --json headRefName,headRefOid,title,url > .review-target/pr.json
git add -f .review-target/pr-number .review-target/pr.diff .review-target/pr.json
