#!/usr/bin/env bash
set -euo pipefail

pr=${1:?usage: swarm-prepare.sh PR_NUMBER GATE_CHECKOUT}
gate_checkout=${2:?usage: swarm-prepare.sh PR_NUMBER GATE_CHECKOUT}

mkdir -p .review-target .review-gate/scripts
printf '%s\n' "$pr" > .review-target/pr-number
gh pr diff "$pr" > .review-target/pr.diff
gh pr view "$pr" --json headRefName,headRefOid,title,url > .review-target/pr.json
printf 'created by the cloud fetch step\n' > .review-target/sync-start

# These copies come from the separately checked-out main branch. The PR cannot
# alter the gate that judges it (RFC-0001 settled decision 6).
cp "$gate_checkout/workflows/review-swarm.yaml" .review-gate/review-swarm.yaml
cp "$gate_checkout/.github/workflows/scripts/swarm-verdict.sh" \
  .review-gate/scripts/swarm-verdict.sh

# cloud run uploads the tracked tree, including these generated review inputs.
git add -f .review-target .review-gate
git diff --cached --quiet -- .review-target .review-gate && {
  echo "PREPARE_FAILED: review context was not staged" >&2
  exit 1
}
