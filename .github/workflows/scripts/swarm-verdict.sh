#!/usr/bin/env bash

swarm_latest_transcript() {
  local review_dir=$1 pr=$2 lens=$3
  find "$review_dir" -maxdepth 1 -type f -name "*-pr${pr}-${lens}.md" -printf '%f\n' 2>/dev/null |
    LC_ALL=C sort |
    tail -n 1
}

swarm_transcript_verdict() {
  awk 'NF { line=$0 } END {
    n=split(line, fields, /[[:space:]]+/)
    token=fields[n]
    if (token == "REVIEW_PASSED" || token == "REVIEW_FAILED") print token
    else print "UNCLEAR"
  }' "$1"
}

swarm_evaluate() {
  local review_dir=$1 pr=$2 fresh_since=${3:-} lens name path verdict overall=0
  SWARM_RESULTS=''
  for lens in maintainability history structure; do
    name=$(swarm_latest_transcript "$review_dir" "$pr" "$lens")
    if [ -z "$name" ]; then
      verdict=MISSING
      path=''
    else
      path="$review_dir/$name"
      verdict=$(swarm_transcript_verdict "$path")
      if [ -n "$fresh_since" ] && [ "$(stat -c %Y "$path")" -lt "$fresh_since" ]; then
        verdict=STALE
      fi
    fi
    [ "$verdict" = REVIEW_PASSED ] || overall=1
    SWARM_RESULTS="${SWARM_RESULTS}${lens}|${verdict}|${path}"$'\n'
  done
  export SWARM_RESULTS
  return "$overall"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  review_dir=${1:?usage: swarm-verdict.sh REVIEW_DIR PR_NUMBER [FRESH_SINCE_EPOCH]}
  pr=${2:?usage: swarm-verdict.sh REVIEW_DIR PR_NUMBER [FRESH_SINCE_EPOCH]}
  fresh_since=${3:-}
  if swarm_evaluate "$review_dir" "$pr" "$fresh_since"; then
    printf '%s' "$SWARM_RESULTS"
    echo SWARM_PASSED
  else
    printf '%s' "$SWARM_RESULTS"
    echo SWARM_FAILED
    exit 1
  fi
fi
