#!/usr/bin/env bash
set -euo pipefail

pr_number=${1:?usage: swarm-wrapper-guard.sh PR_NUMBER}
changed_files=$(gh api --paginate "repos/${GITHUB_REPOSITORY}/pulls/${pr_number}/files" --jq '.[].filename')

if grep -Fxq '.github/workflows/review-swarm.yml' <<<"$changed_files"; then
  echo "candidate changes review-swarm.yml; wrapper enforcement is base-owned and immutable" >&2
  exit 1
fi

echo "REVIEW_SWARM_WRAPPER_GUARD_OK"
