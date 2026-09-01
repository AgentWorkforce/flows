#!/usr/bin/env bash
set -euo pipefail

gate_root=${1:?usage: swarm-prepare.sh GATE_ROOT TARGET_ROOT PR_NUMBER}
target_root=${2:?usage: swarm-prepare.sh GATE_ROOT TARGET_ROOT PR_NUMBER}
pr_number=${3:?usage: swarm-prepare.sh GATE_ROOT TARGET_ROOT PR_NUMBER}

[[ "$pr_number" =~ ^[1-9][0-9]*$ ]] || {
  echo "PREPARE_FAILED: invalid PR number: $pr_number" >&2
  exit 64
}

mkdir -p "$target_root/.review-target" "$target_root/.review-gate"
printf '%s\n' "$pr_number" > "$target_root/.review-target/pr-number"
date +%s > "$target_root/.review-target/sync-started"
gh pr diff "$pr_number" --repo "$GITHUB_REPOSITORY" \
  > "$target_root/.review-target/pr.diff"
gh pr view "$pr_number" --repo "$GITHUB_REPOSITORY" \
  --json headRefName,headRefOid,title,url \
  > "$target_root/.review-target/pr.json"

# Only main's separately checked-out gate files enter the executable bundle.
cp "$gate_root/workflows/review-swarm.yaml" "$target_root/.review-gate/review-swarm.yaml"
cp "$gate_root/.github/workflows/scripts/swarm-verdict.sh" \
  "$target_root/.review-gate/swarm-verdict.sh"

git -C "$target_root" add -f .review-target .review-gate
for evidence in pr-number sync-started pr.diff pr.json; do
  git -C "$target_root" ls-files --error-unmatch ".review-target/$evidence" >/dev/null || {
    echo "PREPARE_FAILED: .review-target/$evidence was not staged" >&2
    exit 70
  }
done
