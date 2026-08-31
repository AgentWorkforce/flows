#!/usr/bin/env bash
set -euo pipefail

run_id=${1:?usage: swarm-post.sh RUN_ID TARGET_DIR}
target_dir=${2:?usage: swarm-post.sh RUN_ID TARGET_DIR}
repo=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}
pr=$(tr -dc '0-9' < "$target_dir/.review-target/pr-number")
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=swarm-verdict.sh
. "$script_dir/swarm-verdict.sh"

upsert_comment() {
  local anchor=$1 body_file=$2 comment_id
  comment_id=$(gh api "repos/$repo/issues/$pr/comments" --paginate \
    --jq ".[] | select(.body | contains(\"$anchor\")) | .id" | head -n 1)
  if [ -n "$comment_id" ]; then
    gh api --method PATCH "repos/$repo/issues/comments/$comment_id" \
      --raw-field "body=$(cat "$body_file")" >/dev/null
  else
    gh api --method POST "repos/$repo/issues/$pr/comments" \
      --raw-field "body=$(cat "$body_file")" >/dev/null
  fi
}

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
verdicts=()
for lens in maintainability history structure; do
  anchor="<!-- swarm-lens: $lens -->"
  filename=$(swarm_latest_transcript "$target_dir/ops/reviews" "$pr" "$lens")
  file=${filename:+$target_dir/ops/reviews/$filename}
  verdict=$(swarm_transcript_verdict "$file")
  verdicts+=("$verdict")
  {
    printf '%s\n\n### Review swarm: %s — %s\n\n' "$anchor" "$lens" "$verdict"
    if [ -n "$file" ] && [ -f "$file" ]; then cat "$file"; else echo "No transcript was produced."; fi
  } > "$tmp_dir/$lens.md"
  upsert_comment "$anchor" "$tmp_dir/$lens.md"
done

overall=$(swarm_overall_verdict "${verdicts[@]}")
{
  echo '<!-- review-swarm-status -->'
  echo
  echo "### Review swarm: $overall"
  echo
  echo "Cloud run: \`$run_id\`"
} > "$tmp_dir/status.md"
upsert_comment '<!-- review-swarm-status -->' "$tmp_dir/status.md"
