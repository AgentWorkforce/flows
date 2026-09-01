#!/bin/sh
# One fail-closed verdict implementation for the cloud aggregate and PR poster.

swarm_lenses='maintainability history structure'

swarm_latest_transcript() {
  review_dir=$1
  pr_number=$2
  lens=$3
  find "$review_dir" -maxdepth 1 -type f \
    -name "????????-????-pr${pr_number}-${lens}.md" -print 2>/dev/null |
    LC_ALL=C sort | tail -n 1
}

swarm_transcript_verdict() {
  transcript=$1
  last_line=$(awk 'NF { line=$0 } END { print line }' "$transcript")
  set -- $last_line
  last_token=''
  for token do last_token=$token; done
  case "$last_token" in
    REVIEW_PASSED) printf '%s\n' PASSED ;;
    REVIEW_FAILED) printf '%s\n' FAILED ;;
    *) printf '%s\n' UNCLEAR ;;
  esac
}

# Prints one tab-separated row per lens: lens, verdict, transcript path.
# Returns success only when every lens has a newly-produced passing transcript.
swarm_evaluate() {
  review_dir=$1
  pr_number=$2
  not_before=${3:-0}
  overall=0

  for lens in $swarm_lenses; do
    transcript=$(swarm_latest_transcript "$review_dir" "$pr_number" "$lens")
    if [ -z "$transcript" ]; then
      printf '%s\t%s\t%s\n' "$lens" MISSING ''
      overall=1
      continue
    fi

    modified=$(stat -c %Y "$transcript" 2>/dev/null || printf '0')
    if [ "$modified" -lt "$not_before" ]; then
      verdict=STALE
      overall=1
    else
      verdict=$(swarm_transcript_verdict "$transcript")
      [ "$verdict" = PASSED ] || overall=1
    fi
    printf '%s\t%s\t%s\n' "$lens" "$verdict" "$transcript"
  done
  return "$overall"
}

if [ "${0##*/}" = swarm-verdict.sh ]; then
  [ "$#" -eq 3 ] || {
    echo "usage: swarm-verdict.sh REVIEW_DIR PR_NUMBER NOT_BEFORE" >&2
    exit 64
  }
  swarm_evaluate "$1" "$2" "$3"
fi
