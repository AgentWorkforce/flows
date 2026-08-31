#!/usr/bin/env bash

# Shared by the immutable cloud aggregate and the GitHub result publisher.

swarm_latest_transcript() {
  local directory=$1 pr=$2 lens=$3
  find "$directory" -maxdepth 1 -type f \
    -name "????????-????-pr${pr}-${lens}.md" -printf '%f\n' 2>/dev/null \
    | LC_ALL=C sort | tail -n 1
}

swarm_transcript_verdict() {
  local file=${1:-} line token
  if [ -z "$file" ] || [ ! -f "$file" ]; then
    printf '%s\n' MISSING
    return
  fi
  token=$(awk 'NF { token=$NF } END { print token }' "$file")
  case "$token" in
    REVIEW_PASSED) printf '%s\n' PASSED ;;
    REVIEW_FAILED) printf '%s\n' FAILED ;;
    *) printf '%s\n' UNCLEAR ;;
  esac
}

swarm_overall_verdict() {
  local verdict
  for verdict in "$@"; do
    [ "$verdict" = PASSED ] || { printf '%s\n' FAILED; return; }
  done
  [ "$#" -gt 0 ] && printf '%s\n' PASSED || printf '%s\n' FAILED
}
