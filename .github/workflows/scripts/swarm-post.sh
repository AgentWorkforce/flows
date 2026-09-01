#!/usr/bin/env bash
set -euo pipefail

target_root=${1:?usage: swarm-post.sh TARGET_ROOT PR RUN_ID STATUS SYNC_STARTED}
pr_number=${2:?usage: swarm-post.sh TARGET_ROOT PR RUN_ID STATUS SYNC_STARTED}
run_id=${3:?usage: swarm-post.sh TARGET_ROOT PR RUN_ID STATUS SYNC_STARTED}
run_status=${4:?usage: swarm-post.sh TARGET_ROOT PR RUN_ID STATUS SYNC_STARTED}
sync_started=${5:?usage: swarm-post.sh TARGET_ROOT PR RUN_ID STATUS SYNC_STARTED}

agent-relay cloud sync "$run_id" --dir "$target_root"

# shellcheck source=swarm-verdict.sh
source "$target_root/.review-gate/swarm-verdict.sh"
rows=$(mktemp)
trap 'rm -f "$rows"' EXIT
overall=REVIEW_PASSED
if ! swarm_evaluate "$target_root" "$pr_number" "$sync_started" > "$rows"; then
  overall=REVIEW_FAILED
fi

upsert_comment() {
  local anchor=$1 body_file=$2 comment_id
  comment_id=$(gh api \
    "repos/$GITHUB_REPOSITORY/issues/$pr_number/comments?per_page=100" \
    --jq ".[] | select(.body | contains(\"$anchor\")) | .id" | sed -n '1p')
  if [[ -n "$comment_id" ]]; then
    gh api --method PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$comment_id" \
      -F "body=@$body_file" >/dev/null
  else
    gh pr comment "$pr_number" --repo "$GITHUB_REPOSITORY" \
      --body-file "$body_file" >/dev/null
  fi
}

marker=$(mktemp)
trap 'rm -f "$rows" "$marker"' EXIT
{
  echo '<!-- review-swarm -->'
  echo "Review swarm run \`$run_id\`: **$overall** (cloud status: \`$run_status\`)."
} > "$marker"
upsert_comment '<!-- review-swarm -->' "$marker"

while IFS=$'\t' read -r lens verdict transcript; do
  body=$(mktemp)
  {
    echo "<!-- swarm-lens: $lens -->"
    echo "### Review swarm: $lens"
    echo
    echo "Verdict: **$verdict**"
    echo
    if [[ "$transcript" != - ]]; then
      cat "$transcript"
    else
      echo '_No transcript was produced by this run._'
    fi
  } > "$body"
  upsert_comment "<!-- swarm-lens: $lens -->" "$body"
  rm -f "$body"
done < "$rows"

echo "overall=$overall" >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
