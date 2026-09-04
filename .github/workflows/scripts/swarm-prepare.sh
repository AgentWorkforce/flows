#!/bin/sh
set -eu

pr=$1
gate_root=$2
target_dir=.review-target

case "$pr" in *[!0-9]*|'') echo "PREPARE_FAILED: invalid PR number" >&2; exit 64;; esac
[ -f "$gate_root/.github/workflows/scripts/swarm-verdict.sh" ] || {
  echo "PREPARE_FAILED: trusted verdict helper missing" >&2; exit 66;
}

mkdir -p "$target_dir"
printf '%s\n' "$pr" > "$target_dir/pr-number"
gh pr diff "$pr" > "$target_dir/pr.diff"
gh pr view "$pr" --json headRefName,headRefOid,title,url > "$target_dir/pr.json"
cp "$gate_root/.github/workflows/scripts/swarm-verdict.sh" \
  "$target_dir/swarm-verdict.sh"

for file in pr-number pr.diff pr.json swarm-verdict.sh; do
  [ -s "$target_dir/$file" ] || {
    echo "PREPARE_FAILED: $target_dir/$file is empty" >&2; exit 65;
  }
done
git add -f "$target_dir"
