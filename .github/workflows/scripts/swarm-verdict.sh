#!/bin/sh

SWARM_LENSES="maintainability history structure"

swarm_latest_transcript() {
  pr=$1
  lens=$2
  reviews_dir=$3
  find "$reviews_dir" -maxdepth 1 -type f -name "*-pr${pr}-${lens}.md" \
    -print 2>/dev/null | LC_ALL=C sort | tail -n 1
}

swarm_transcript_verdict() {
  awk 'NF { line=$0 } END {
    count=split(line, words, /[[:space:]]+/)
    print count ? words[count] : ""
  }' "$1"
}

swarm_evaluate() {
  pr=$1
  reviews_dir=$2
  failed=0

  for lens in $SWARM_LENSES; do
    transcript=$(swarm_latest_transcript "$pr" "$lens" "$reviews_dir")
    if [ -z "$transcript" ]; then
      echo "SWARM_FAILED: $lens transcript MISSING"
      failed=1
      continue
    fi

    verdict=$(swarm_transcript_verdict "$transcript")
    if [ "$verdict" = REVIEW_PASSED ]; then
      echo "SWARM_LENS: $lens PASSED $transcript"
    elif [ "$verdict" = REVIEW_FAILED ]; then
      echo "SWARM_FAILED: $lens FAILED $transcript"
      failed=1
    else
      echo "SWARM_FAILED: $lens UNCLEAR $transcript"
      failed=1
    fi
  done

  [ "$failed" -eq 0 ] && { echo SWARM_PASSED; return 0; }
  return 1
}
