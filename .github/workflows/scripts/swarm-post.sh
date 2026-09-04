#!/usr/bin/env bash
set -euo pipefail

run_id=${1:?usage: swarm-post.sh RUN_ID PR_NUMBER TRUSTED_VERDICT_SCRIPT}
pr=${2:?usage: swarm-post.sh RUN_ID PR_NUMBER TRUSTED_VERDICT_SCRIPT}
trusted_verdict=${3:?usage: swarm-post.sh RUN_ID PR_NUMBER TRUSTED_VERDICT_SCRIPT}
sync_started=$(date +%s)

agent-relay cloud sync "$run_id"
# source the immutable checkout's swarm-verdict.sh, supplied by the workflow.
# shellcheck source=/dev/null
source "$trusted_verdict"

swarm_evaluate ops/reviews "$pr" || true
fresh=1
while IFS='|' read -r lens verdict transcript; do
  [ -n "$lens" ] || continue
  if [ -z "$transcript" ] || [ ! -f "$transcript" ]; then
    fresh=0
  else
    mtime=$(stat -c %Y "$transcript")
    [ "$mtime" -ge "$sync_started" ] || fresh=0
  fi
done <<< "$SWARM_RESULTS"
[ "$fresh" -eq 1 ] || SWARM_OVERALL=FAILED

upsert_comment() {
  local anchor=$1 body_file=$2 comment_id
  comment_id=$(gh api --paginate "repos/${GITHUB_REPOSITORY}/issues/${pr}/comments" \
    --jq ".[] | select(.body | contains(\"${anchor}\")) | .id" | head -n 1)
  if [ -n "$comment_id" ]; then
    gh api --method PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${comment_id}" \
      -F "body=@${body_file}" >/dev/null
  else
    gh api --method POST "repos/${GITHUB_REPOSITORY}/issues/${pr}/comments" \
      -F "body=@${body_file}" >/dev/null
  fi
}

while IFS='|' read -r lens verdict transcript; do
  [ -n "$lens" ] || continue
  body=$(mktemp)
  {
    echo "<!-- swarm-lens: $lens -->"
    echo "### Review swarm: $lens — $verdict"
    echo
    if [ -n "$transcript" ] && [ -f "$transcript" ]; then cat "$transcript"; else echo "Transcript missing."; fi
  } > "$body"
  upsert_comment "<!-- swarm-lens: $lens -->" "$body"
  rm -f "$body"
done <<< "$SWARM_RESULTS"

marker=$(mktemp)
{
  echo '<!-- swarm-marker -->'
  echo "### Review swarm: $SWARM_OVERALL"
  echo
  echo "Cloud run: \`$run_id\`. All three current-run transcripts must pass."
} > "$marker"
upsert_comment '<!-- swarm-marker -->' "$marker"
rm -f "$marker"

[ "$SWARM_OVERALL" = PASSED ]
