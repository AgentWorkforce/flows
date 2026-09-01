#!/bin/sh

# Shared, fail-closed transcript selection and verdict extraction.

swarm_find_transcript() {
  local root=$1 pr=$2 lens=$3
  find "$root/ops/reviews" -maxdepth 1 -type f \
    -name "*-pr${pr}-${lens}.md" -printf '%f\n' 2>/dev/null \
    | LC_ALL=C sort | tail -n 1
}

swarm_transcript_verdict() {
  local transcript=$1 terminal
  terminal=$(sed '/^[[:space:]]*$/d' "$transcript" | tail -n 1)
  terminal=${terminal#${terminal%%[![:space:]]*}}
  terminal=${terminal%${terminal##*[![:space:]]}}
  case "$terminal" in
    REVIEW_PASSED|REVIEW_FAILED) printf '%s\n' "$terminal" ;;
    *) printf '%s\n' REVIEW_UNCLEAR ;;
  esac
}

# Prints one tab-separated row per lens: lens, verdict, absolute transcript.
swarm_evaluate() {
  local root=$1 pr=$2 sync_started=${3:-0}
  local lens name path verdict modified overall=0

  for lens in maintainability history structure; do
    name=$(swarm_find_transcript "$root" "$pr" "$lens")
    if [ -z "$name" ]; then
      printf '%s\t%s\t%s\n' "$lens" REVIEW_MISSING -
      overall=1
      continue
    fi

    path="$root/ops/reviews/$name"
    modified=$(stat -c %Y "$path")
    if [ "$modified" -lt "$sync_started" ]; then
      printf '%s\t%s\t%s\n' "$lens" REVIEW_STALE "$path"
      overall=1
      continue
    fi

    verdict=$(swarm_transcript_verdict "$path")
    printf '%s\t%s\t%s\n' "$lens" "$verdict" "$path"
    [ "$verdict" = REVIEW_PASSED ] || overall=1
  done

  return "$overall"
}
