#!/bin/sh
set -eu

pr_number=${1:?usage: swarm-prepare.sh PR_NUMBER}
case "$pr_number" in *[!0-9]*|'') echo "invalid PR number: $pr_number" >&2; exit 2 ;; esac

mkdir -p .review-target
printf '%s\n' "$pr_number" > .review-target/pr-number
gh pr diff "$pr_number" > .review-target/pr.diff
gh pr view "$pr_number" --json headRefName,headRefOid,title,url > .review-target/pr.json

# cloud run uploads git ls-files, so these launcher-produced inputs must be staged.
git add -f .review-target/pr-number .review-target/pr.diff .review-target/pr.json
git ls-files --error-unmatch .review-target/pr-number .review-target/pr.diff \
  .review-target/pr.json >/dev/null
