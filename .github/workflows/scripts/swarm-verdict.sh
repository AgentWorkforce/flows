#!/usr/bin/env bash

# Shared, fail-closed transcript selection and verdict extraction.
swarm_latest_transcript() {
  local reviews_dir=$1 pr=$2 lens=$3
  find "$reviews_dir" -maxdepth 1 -type f \
    -name "*-pr${pr}-${lens}.md" -printf '%f\n' 2>/dev/null \
    | LC_ALL=C sort \
    | tail -n 1 \
    | sed "s|^|${reviews_dir}/|"
}

swarm_transcript_verdict() {
  local transcript=$1 last_line token
  [ -n "$transcript" ] && [ -f "$transcript" ] || {
    printf '%s\n' MISSING
    return
  }
  last_line=$(awk 'NF { line=$0 } END { print line }' "$transcript")
  token=$(printf '%s\n' "$last_line" | awk '{ print $NF }')
  case "$token" in
    REVIEW_PASSED) printf '%s\n' PASSED ;;
    REVIEW_FAILED) printf '%s\n' FAILED ;;
    *) printf '%s\n' UNCLEAR ;;
  esac
}

swarm_evaluate() {
  local reviews_dir=$1 pr=$2 lens transcript verdict
  SWARM_OVERALL=PASSED
  SWARM_RESULTS=
  for lens in maintainability history structure; do
    transcript=$(swarm_latest_transcript "$reviews_dir" "$pr" "$lens")
    verdict=$(swarm_transcript_verdict "$transcript")
    [ "$verdict" = PASSED ] || SWARM_OVERALL=FAILED
    SWARM_RESULTS="${SWARM_RESULTS}${lens}|${verdict}|${transcript}"$'\n'
  done
  export SWARM_OVERALL SWARM_RESULTS
  [ "$SWARM_OVERALL" = PASSED ]
}
