#!/usr/bin/env bash

# Shared by the cloud aggregate and the GitHub-side publisher. Callers choose
# whether to supply a lower mtime bound for newly-synced transcript evidence.

swarm_find_transcript() {
  local reviews_dir=$1 pr_number=$2 lens=$3

  find "$reviews_dir" -maxdepth 1 -type f \
    -name "????????-????-pr${pr_number}-${lens}.md" -print 2>/dev/null \
    | LC_ALL=C sort \
    | tail -n 1
}

swarm_last_verdict() {
  local transcript=$1 last_line

  last_line=$(awk 'NF { line=$0 } END { print line }' "$transcript")
  if [[ $last_line =~ (^|[[:space:]])(REVIEW_PASSED|REVIEW_FAILED)([[:space:]]|$) ]]; then
    printf '%s\n' "${BASH_REMATCH[2]}"
  else
    printf '%s\n' "REVIEW_UNCLEAR"
  fi
}

swarm_evaluate_lens() {
  local reviews_dir=$1 pr_number=$2 lens=$3 minimum_mtime=${4:-}
  local transcript verdict mtime

  transcript=$(swarm_find_transcript "$reviews_dir" "$pr_number" "$lens")
  if [ -z "$transcript" ]; then
    printf 'MISSING\t\tREVIEW_MISSING\n'
    return 1
  fi

  if [ -n "$minimum_mtime" ]; then
    mtime=$(stat -c %Y "$transcript")
    if [ "$mtime" -lt "$minimum_mtime" ]; then
      printf 'STALE\t%s\tREVIEW_STALE\n' "$transcript"
      return 1
    fi
  fi

  verdict=$(swarm_last_verdict "$transcript")
  if [ "$verdict" = REVIEW_PASSED ]; then
    printf 'PASSED\t%s\t%s\n' "$transcript" "$verdict"
    return 0
  fi
  if [ "$verdict" = REVIEW_FAILED ]; then
    printf 'FAILED\t%s\t%s\n' "$transcript" "$verdict"
  else
    printf 'UNCLEAR\t%s\t%s\n' "$transcript" "$verdict"
  fi
  return 1
}
