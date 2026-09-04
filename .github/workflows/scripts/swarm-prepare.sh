#!/usr/bin/env bash
set -euo pipefail

pr_number=${1:?usage: swarm-prepare.sh PR_NUMBER PR_CHECKOUT GATE_CHECKOUT}
pr_checkout=${2:?usage: swarm-prepare.sh PR_NUMBER PR_CHECKOUT GATE_CHECKOUT}
gate_checkout=${3:?usage: swarm-prepare.sh PR_NUMBER PR_CHECKOUT GATE_CHECKOUT}
target_dir="$pr_checkout/.review-target"

case $pr_number in
  ''|*[!0-9]*) echo "invalid PR number: $pr_number" >&2; exit 2 ;;
esac

mkdir -p "$target_dir"
printf '%s\n' "$pr_number" > "$target_dir/pr-number"
gh pr diff "$pr_number" --repo "$GITHUB_REPOSITORY" > "$target_dir/pr.diff"
gh pr view "$pr_number" --repo "$GITHUB_REPOSITORY" \
  --json headRefName,headRefOid,title,url > "$target_dir/pr.json"

# The uploaded helper is copied from main's checkout. The reviewed head cannot
# alter the verdict code used by the cloud aggregate.
cp "$gate_checkout/.github/workflows/scripts/swarm-verdict.sh" \
  "$target_dir/swarm-verdict.sh"
git -C "$pr_checkout" add -f .review-target/pr-number .review-target/pr.diff \
  .review-target/pr.json .review-target/swarm-verdict.sh
