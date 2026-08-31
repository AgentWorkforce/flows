#!/usr/bin/env bash
set -euo pipefail

run_id=${1:?usage: swarm-post.sh RUN_ID PR_NUMBER PR_TREE}
pr=${2:?usage: swarm-post.sh RUN_ID PR_NUMBER PR_TREE}
pr_tree=${3:?usage: swarm-post.sh RUN_ID PR_NUMBER PR_TREE}
script_dir=$(cd "$(dirname "$0")" && pwd)
sync_started=$(date +%s)

agent-relay cloud sync "$run_id" --dir "$pr_tree"
. "$script_dir/swarm-verdict.sh"
swarm_extract_verdicts "$pr_tree/ops/reviews" "$pr" "$sync_started"

upsert_comment() {
  local anchor=$1 body_file=$2 comment_id
  comment_id=$(gh api --paginate "repos/{owner}/{repo}/issues/$pr/comments" \
    --jq ".[] | select(.body | contains(\"$anchor\")) | .id" | head -n 1)
  if [ -n "$comment_id" ]; then
    gh api --method PATCH "repos/{owner}/{repo}/issues/comments/$comment_id" \
      --raw-field "body=$(cat "$body_file")" >/dev/null
  else
    gh api --method POST "repos/{owner}/{repo}/issues/$pr/comments" \
      --raw-field "body=$(cat "$body_file")" >/dev/null
  fi
}

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
for lens in maintainability history structure; do
  upper=$(printf '%s' "$lens" | tr '[:lower:]' '[:upper:]')
  eval "file=\${SWARM_${upper}_FILE}"
  eval "verdict=\${SWARM_${upper}_VERDICT}"
  body="$tmp_dir/$lens.md"
  {
    echo "<!-- swarm-lens: $lens -->"
    echo "### Review swarm: $lens — $verdict"
    echo
    if [ -n "$file" ] && [ "$verdict" != STALE ]; then cat "$file"; else echo "No fresh transcript was produced for cloud run \`$run_id\`."; fi
  } > "$body"
  upsert_comment "<!-- swarm-lens: $lens -->" "$body"
done

marker="$tmp_dir/marker.md"
{
  echo '<!-- review-swarm -->'
  echo "### Review swarm: $SWARM_OVERALL"
  echo
  echo "Cloud run: \`$run_id\`"
  for lens in maintainability history structure; do
    upper=$(printf '%s' "$lens" | tr '[:lower:]' '[:upper:]')
    eval "verdict=\${SWARM_${upper}_VERDICT}"
    echo "- $lens: $verdict"
  done
} > "$marker"
upsert_comment '<!-- review-swarm -->' "$marker"

[ "$SWARM_OVERALL" = PASSED ]
