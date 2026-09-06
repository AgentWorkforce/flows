#!/usr/bin/env bash

# Shared, fail-closed review transcript selection and verdict extraction.
swarm_latest_transcript() {
  local reviews_dir=$1 pr=$2 lens=$3
  find "$reviews_dir" -maxdepth 1 -type f \
    -name "????????-????-pr${pr}-${lens}.md" -print 2>/dev/null |
    LC_ALL=C sort | tail -n 1
}

swarm_transcript_verdict() {
  local transcript=$1 last_line
  last_line=$(awk 'NF { last=$0 } END { print last }' "$transcript")
  last_line=${last_line#"${last_line%%[![:space:]]*}"}
  last_line=${last_line%"${last_line##*[![:space:]]}"}
  case "$last_line" in
    REVIEW_PASSED) printf '%s\n' PASSED ;;
    REVIEW_FAILED) printf '%s\n' FAILED ;;
    *) printf '%s\n' UNCLEAR ;;
  esac
}

swarm_lens_result() {
  local reviews_dir=$1 pr=$2 lens=$3 freshness_marker=${4:-}
  local transcript
  transcript=$(swarm_latest_transcript "$reviews_dir" "$pr" "$lens")
  if [ -z "$transcript" ]; then
    printf 'MISSING\t\n'
  elif [ -n "$freshness_marker" ] && [ ! "$transcript" -nt "$freshness_marker" ]; then
    printf 'STALE\t%s\n' "$transcript"
  else
    printf '%s\t%s\n' "$(swarm_transcript_verdict "$transcript")" "$transcript"
  fi
}
