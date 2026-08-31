#!/bin/sh

swarm_lenses="maintainability history structure"

swarm_transcript() {
  review_dir=$1
  pr_number=$2
  lens=$3
  find "$review_dir" -maxdepth 1 -type f -name "*-pr${pr_number}-${lens}.md" \
    -printf '%f\n' 2>/dev/null | LC_ALL=C sort -r | head -n 1
}

swarm_lens_verdict() {
  transcript=$1
  sync_started=$2
  [ -n "$transcript" ] && [ -f "$transcript" ] || {
    printf '%s\n' MISSING
    return
  }
  [ "$(stat -c %Y "$transcript")" -ge "$sync_started" ] || {
    printf '%s\n' STALE
    return
  }
  token=$(awk 'NF { token=$NF } END { print token }' "$transcript")
  case "$token" in
    REVIEW_PASSED) printf '%s\n' PASSED ;;
    REVIEW_FAILED) printf '%s\n' FAILED ;;
    *) printf '%s\n' UNCLEAR ;;
  esac
}

swarm_overall_verdict() {
  review_dir=$1
  pr_number=$2
  sync_started=$3
  overall=PASSED
  for lens in $swarm_lenses; do
    name=$(swarm_transcript "$review_dir" "$pr_number" "$lens")
    verdict=$(swarm_lens_verdict "$review_dir/$name" "$sync_started")
    [ "$verdict" = PASSED ] || overall=FAILED
    printf '%s\t%s\t%s\n' "$lens" "$verdict" "$name"
  done
  printf 'overall\t%s\n' "$overall"
  [ "$overall" = PASSED ]
}
