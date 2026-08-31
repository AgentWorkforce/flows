#!/usr/bin/env bash
set -euo pipefail

lenses=(maintainability history structure)

latest_transcript() {
  local review_dir=$1 pr_number=$2 lens=$3
  find "$review_dir" -maxdepth 1 -type f -name "????????-????-pr${pr_number}-${lens}.md" -print \
    | LC_ALL=C sort | tail -n 1
}

transcript_verdict() {
  local transcript=$1 token
  [ -n "$transcript" ] && [ -f "$transcript" ] || { echo MISSING; return; }
  token=$(awk 'NF { token=$NF } END { print token }' "$transcript")
  case "$token" in
    REVIEW_PASSED) echo PASSED ;;
    REVIEW_FAILED) echo FAILED ;;
    *) echo UNCLEAR ;;
  esac
}

collect_verdicts() {
  local review_dir=$1 pr_number=$2 minimum_mtime=${3:-0}
  local lens transcript verdict mtime
  SWARM_OVERALL=PASSED
  SWARM_DETAILS=""
  for lens in "${lenses[@]}"; do
    transcript=$(latest_transcript "$review_dir" "$pr_number" "$lens")
    verdict=$(transcript_verdict "$transcript")
    if [ "$verdict" != MISSING ] && [ "$minimum_mtime" -gt 0 ]; then
      mtime=$(stat -c %Y "$transcript")
      [ "$mtime" -ge "$minimum_mtime" ] || verdict=STALE
    fi
    [ "$verdict" = PASSED ] || SWARM_OVERALL=FAILED
    SWARM_DETAILS+="${lens}:${verdict}:${transcript:-none}"$'\n'
  done
}

aggregate() {
  local target_dir=${1:-.} pr_number
  pr_number=$(tr -dc '0-9' < "$target_dir/.review-target/pr-number")
  collect_verdicts "$target_dir/ops/reviews" "$pr_number"
  printf '%s' "$SWARM_DETAILS"
  [ "$SWARM_OVERALL" = PASSED ] && { echo SWARM_PASSED; return; }
  echo SWARM_FAILED >&2
  return 1
}

upsert_comment() {
  local pr_number=$1 anchor=$2 body_file=$3 comment_id
  comment_id=$(gh api --paginate "repos/${GITHUB_REPOSITORY}/issues/${pr_number}/comments" \
    --jq ".[] | select(.body | contains(\"$anchor\")) | .id" | head -n 1)
  if [ -n "$comment_id" ]; then
    gh api --method PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${comment_id}" -F "body=@$body_file" >/dev/null
  else
    gh pr comment "$pr_number" --body-file "$body_file" >/dev/null
  fi
}

post() {
  local run_id=${1:?missing run id} pr_number=${2:?missing PR number} target_dir=${3:?missing target dir}
  local sync_started lens verdict transcript anchor body_file
  sync_started=$(date +%s)
  agent-relay cloud sync "$run_id" --dir "$target_dir"
  collect_verdicts "$target_dir/ops/reviews" "$pr_number" "$sync_started"

  for lens in "${lenses[@]}"; do
    transcript=$(latest_transcript "$target_dir/ops/reviews" "$pr_number" "$lens")
    verdict=$(transcript_verdict "$transcript")
    if [ "$verdict" != MISSING ] && [ "$(stat -c %Y "$transcript")" -lt "$sync_started" ]; then
      verdict=STALE
    fi
    anchor="<!-- swarm-lens: $lens -->"
    body_file=$(mktemp)
    { printf '%s\n\n### Review swarm: %s — %s\n\n' "$anchor" "$lens" "$verdict"; [ -f "$transcript" ] && cat "$transcript" || echo 'No transcript produced.'; } > "$body_file"
    upsert_comment "$pr_number" "$anchor" "$body_file"
    rm -f "$body_file"
  done

  anchor='<!-- review-swarm -->'
  body_file=$(mktemp)
  { printf '%s\n\n### Review swarm — %s\n\nCloud run: `%s`\n\n```text\n' "$anchor" "$SWARM_OVERALL" "$run_id"; printf '%s' "$SWARM_DETAILS"; printf '%s\n' '```'; } > "$body_file"
  upsert_comment "$pr_number" "$anchor" "$body_file"
  rm -f "$body_file"
  [ "$SWARM_OVERALL" = PASSED ]
}

case ${1:-} in
  aggregate) shift; aggregate "$@" ;;
  post) shift; post "$@" ;;
  *) echo "usage: swarm-post.sh {aggregate TARGET_DIR|post RUN_ID PR_NUMBER TARGET_DIR}" >&2; exit 64 ;;
esac
