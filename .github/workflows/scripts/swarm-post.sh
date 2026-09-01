#!/usr/bin/env bash
set -euo pipefail

SWARM_LENSES=(maintainability history structure)

swarm_latest_transcript() {
  local review_dir=$1 pr_number=$2 lens=$3
  find "$review_dir" -maxdepth 1 -type f \
    -name "*-pr${pr_number}-${lens}.md" -print 2>/dev/null \
    | LC_ALL=C sort | tail -n 1
}

swarm_transcript_verdict() {
  local transcript=$1 terminal
  terminal=$(awk 'NF { line=$0 } END { print line }' "$transcript")
  case "$terminal" in
    *REVIEW_PASSED) printf '%s\n' PASSED ;;
    *REVIEW_FAILED) printf '%s\n' FAILED ;;
    *) printf '%s\n' UNCLEAR ;;
  esac
}

swarm_evaluate() {
  local review_dir=$1 pr_number=$2 min_mtime=${3:-0}
  local lens transcript verdict failed=0 mtime
  for lens in "${SWARM_LENSES[@]}"; do
    transcript=$(swarm_latest_transcript "$review_dir" "$pr_number" "$lens")
    if [ -z "$transcript" ]; then
      echo "SWARM_FAILED: $lens produced no transcript"
      failed=1
      continue
    fi
    mtime=$(stat -c %Y "$transcript")
    if [ "$mtime" -lt "$min_mtime" ]; then
      echo "SWARM_FAILED: $lens transcript is stale ($transcript)"
      failed=1
      continue
    fi
    verdict=$(swarm_transcript_verdict "$transcript")
    if [ "$verdict" = PASSED ]; then
      echo "ok: $lens passed ($transcript)"
    else
      echo "SWARM_FAILED: $lens verdict is $verdict ($transcript)"
      failed=1
    fi
  done
  [ "$failed" -eq 0 ] && echo SWARM_PASSED || return 1
}

sticky_comment() {
  local pr_number=$1 anchor=$2 body_file=$3 comment_id actor
  actor=$(gh api user --jq .login)
  comment_id=$(ACTOR="$actor" ANCHOR="$anchor" \
    gh api --paginate "repos/{owner}/{repo}/issues/${pr_number}/comments" \
    --jq '.[] | select(.user.login == env.ACTOR and (.body | contains(env.ANCHOR))) | .id' \
    | tail -n 1)
  if [ -n "$comment_id" ]; then
    gh api --method PATCH "repos/{owner}/{repo}/issues/comments/$comment_id" \
      --raw-field "body=$(cat "$body_file")" >/dev/null
  else
    gh pr comment "$pr_number" --body-file "$body_file" >/dev/null
  fi
}

post_swarm() {
  local run_id=$1 pr_number=$2 target_tree=$3 sync_started=$4 swarm_status=$5
  local lens transcript marker verdict verdict_output body_file overall=FAILED

  agent-relay cloud sync "$run_id" --dir "$target_tree"
  verdict_output=$(mktemp)
  if swarm_evaluate "$target_tree/ops/reviews" "$pr_number" "$sync_started" \
    | tee "$verdict_output"; then
    overall=PASSED
  fi

  marker=$(mktemp)
  {
    echo '<!-- review-swarm: status -->'
    echo "Review swarm **$overall** (cloud run \`$run_id\`, terminal status \`$swarm_status\`)."
    echo
    echo '```text'
    cat "$verdict_output"
    echo '```'
  } > "$marker"
  sticky_comment "$pr_number" '<!-- review-swarm: status -->' "$marker"

  for lens in "${SWARM_LENSES[@]}"; do
    transcript=$(swarm_latest_transcript "$target_tree/ops/reviews" "$pr_number" "$lens")
    body_file=$(mktemp)
    echo "<!-- swarm-lens: $lens -->" > "$body_file"
    if [ -n "$transcript" ] && [ "$(stat -c %Y "$transcript")" -ge "$sync_started" ]; then
      cat "$transcript" >> "$body_file"
    else
      echo "SWARM_FAILED: no fresh $lens transcript for cloud run \`$run_id\`." >> "$body_file"
    fi
    sticky_comment "$pr_number" "<!-- swarm-lens: $lens -->" "$body_file"
  done
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  [ "$#" -eq 5 ] || {
    echo "usage: swarm-post.sh <run-id> <pr-number> <target-tree> <sync-start-epoch> <status>" >&2
    exit 2
  }
  post_swarm "$@"
fi
