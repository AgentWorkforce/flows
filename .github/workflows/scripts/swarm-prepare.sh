#!/usr/bin/env bash
set -euo pipefail

pr=${1:?usage: swarm-prepare.sh PR_NUMBER TRUSTED_VERDICT_SCRIPT}
trusted_verdict=${2:?usage: swarm-prepare.sh PR_NUMBER TRUSTED_VERDICT_SCRIPT}

case "$pr" in *[!0-9]*|'') echo "invalid PR number: $pr" >&2; exit 1 ;; esac
[ -f "$trusted_verdict" ] || { echo "trusted verdict script missing" >&2; exit 1; }

mkdir -p .review-target
printf '%s\n' "$pr" > .review-target/pr-number
gh pr diff "$pr" > .review-target/pr.diff
gh pr view "$pr" --json headRefName,headRefOid,title,url > .review-target/pr.json
cp "$trusted_verdict" .review-target/swarm-verdict.sh
git add -f .review-target/pr-number .review-target/pr.diff \
  .review-target/pr.json .review-target/swarm-verdict.sh
