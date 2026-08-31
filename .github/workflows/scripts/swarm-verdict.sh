#!/bin/sh
# Shared, fail-closed transcript selection and verdict extraction.

swarm_latest_transcript() {
  transcript_dir=$1
  pr_number=$2
  lens=$3
  find "$transcript_dir" -maxdepth 1 -type f \
    -name "*-pr${pr_number}-${lens}.md" -print 2>/dev/null | LC_ALL=C sort | tail -n 1
}

swarm_transcript_verdict() {
  transcript=$1
  token=$(awk 'NF { token=$NF } END { print token }' "$transcript")
  case "$token" in
    REVIEW_PASSED) printf '%s\n' PASSED ;;
    REVIEW_FAILED) printf '%s\n' FAILED ;;
    *) printf '%s\n' UNCLEAR ;;
  esac
}

swarm_is_fresh() {
  transcript=$1
  sync_start=$2
  [ -f "$sync_start" ] || return 1
  [ "$(stat -c %Y "$transcript")" -ge "$(stat -c %Y "$sync_start")" ]
}

swarm_evaluate() {
  transcript_dir=$1
  pr_number=$2
  sync_start=$3
  swarm_failed=0

  for lens in maintainability history structure; do
    transcript=$(swarm_latest_transcript "$transcript_dir" "$pr_number" "$lens")
    if [ -z "$transcript" ]; then
      echo "SWARM_FAILED: $lens produced no transcript"
      swarm_failed=1
      continue
    fi
    if ! swarm_is_fresh "$transcript" "$sync_start"; then
      echo "SWARM_FAILED: $lens transcript predates sync start ($transcript)"
      swarm_failed=1
      continue
    fi
    verdict=$(swarm_transcript_verdict "$transcript")
    if [ "$verdict" = PASSED ]; then
      echo "ok: $lens passed ($transcript)"
    else
      echo "SWARM_FAILED: $lens verdict is $verdict ($transcript)"
      swarm_failed=1
    fi
  done

  [ "$swarm_failed" -eq 0 ] && { echo SWARM_PASSED; return 0; }
  return 1
}
