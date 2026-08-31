#!/usr/bin/env bash
set -euo pipefail

pr_number=${1:?usage: swarm-prepare.sh PR_NUMBER TARGET_DIR TRUSTED_POST_SCRIPT}
target_dir=${2:?usage: swarm-prepare.sh PR_NUMBER TARGET_DIR TRUSTED_POST_SCRIPT}
trusted_post=${3:?usage: swarm-prepare.sh PR_NUMBER TARGET_DIR TRUSTED_POST_SCRIPT}

case "$pr_number" in
  *[!0-9]*|'') echo "invalid PR number: $pr_number" >&2; exit 64 ;;
esac

review_dir="$target_dir/.review-target"
mkdir -p "$review_dir"
printf '%s\n' "$pr_number" > "$review_dir/pr-number"
gh pr diff "$pr_number" > "$review_dir/pr.diff"
gh pr view "$pr_number" --json headRefName,headRefOid,title,url > "$review_dir/pr.json"

# The aggregate executes inside the uploaded PR tree, so replace any head copy
# with the separately checked-out main copy before staging the upload.
mkdir -p "$target_dir/.github/workflows/scripts"
cp "$trusted_post" "$target_dir/.github/workflows/scripts/swarm-post.sh"
chmod +x "$target_dir/.github/workflows/scripts/swarm-post.sh"
git -C "$target_dir" add -f .review-target/pr-number .review-target/pr.diff .review-target/pr.json \
  .github/workflows/scripts/swarm-post.sh
echo "Prepared PR #$pr_number review input on the authenticated launching host."
