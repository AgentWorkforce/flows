#!/bin/sh
# Sync a completed cloud run and upsert its three lens transcripts on the PR.
set -eu

run_id=${1:?usage: swarm-post.sh RUN_ID PR_NUMBER REPOSITORY}
pr_number=${2:?usage: swarm-post.sh RUN_ID PR_NUMBER REPOSITORY}
repository=${3:?usage: swarm-post.sh RUN_ID PR_NUMBER REPOSITORY}

sync_started=.review-target/sync-start
agent-relay cloud sync "$run_id"

. .github/workflows/scripts/swarm-verdict.sh
overall=PASSED
swarm_evaluate ops/reviews "$pr_number" "$sync_started" || overall=FAILED

upsert_comment() {
  anchor=$1
  body_file=$2
  comment_id=$(gh api --paginate "repos/$repository/issues/$pr_number/comments" \
    --jq ".[] | select(.body | contains(\"$anchor\")) | .id" | head -n 1)
  if [ -n "$comment_id" ]; then
    gh api --method PATCH "repos/$repository/issues/comments/$comment_id" \
      --raw-field "body=$(cat "$body_file")" >/dev/null
  else
    gh api --method POST "repos/$repository/issues/$pr_number/comments" \
      --raw-field "body=$(cat "$body_file")" >/dev/null
  fi
}

for lens in maintainability history structure; do
  transcript=$(swarm_latest_transcript ops/reviews "$pr_number" "$lens")
  comment_file=$(mktemp)
  {
    echo "<!-- swarm-lens: $lens -->"
    echo "### Review swarm: $lens"
    echo
    if [ -n "$transcript" ] && swarm_is_fresh "$transcript" "$sync_started"; then
      cat "$transcript"
    else
      echo "SWARM_FAILED: no fresh transcript was produced for this run."
    fi
  } > "$comment_file"
  upsert_comment "<!-- swarm-lens: $lens -->" "$comment_file"
  rm -f "$comment_file"
done

marker_file=$(mktemp)
{
  echo '<!-- review-swarm -->'
  echo "Review swarm run \`$run_id\`: **$overall**"
} > "$marker_file"
upsert_comment '<!-- review-swarm -->' "$marker_file"
rm -f "$marker_file"

[ "$overall" = PASSED ]
