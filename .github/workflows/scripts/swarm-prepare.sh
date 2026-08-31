#!/usr/bin/env bash
set -euo pipefail

pr=${1:?usage: swarm-prepare.sh PR_NUMBER GATE_DIR}
gate_dir=${2:?usage: swarm-prepare.sh PR_NUMBER GATE_DIR}

case "$pr" in *[!0-9]*|'') echo "PREPARE_FAILED: invalid PR number" >&2; exit 2 ;; esac
mkdir -p .review-target .review-gate
printf '%s\n' "$pr" > .review-target/pr-number
gh pr view "$pr" --json headRefName,headRefOid,title,url > .review-target/pr.json
gh pr diff "$pr" > .review-target/pr.diff
cp "$gate_dir/workflows/review-swarm.yaml" .review-gate/review-swarm.yaml
cp "$gate_dir/.github/workflows/scripts/swarm-verdict.sh" .review-gate/swarm-verdict.sh
git add -f .review-target/pr-number .review-target/pr.json .review-target/pr.diff \
  .review-gate/review-swarm.yaml .review-gate/swarm-verdict.sh
echo "PREPARED PR #$pr ($(wc -l < .review-target/pr.diff) diff lines)"
