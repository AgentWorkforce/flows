#!/usr/bin/env bash

# Set SWARM_<LENS>_{FILE,VERDICT} and SWARM_OVERALL from persisted reviews.
# Filenames are timestamps, so lexical order identifies the newest transcript.
swarm_extract_verdicts() {
  local reviews_dir=$1 pr=$2 min_mtime=${3:-0}
  local lens upper file line mtime

  SWARM_OVERALL=PASSED
  for lens in maintainability history structure; do
    upper=$(printf '%s' "$lens" | tr '[:lower:]' '[:upper:]')
    file=$(find "$reviews_dir" -maxdepth 1 -type f \
      -name "*-pr${pr}-${lens}.md" -printf '%f\n' 2>/dev/null | sort | tail -n 1)
    if [ -z "$file" ]; then
      line=MISSING
      file=
    else
      file="$reviews_dir/$file"
      mtime=$(stat -c %Y "$file")
      if [ "$mtime" -lt "$min_mtime" ]; then
        line=STALE
      else
        line=$(sed '/^[[:space:]]*$/d' "$file" | tail -n 1 | tr -d '\r')
        line=$(printf '%s' "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
        case "$line" in
          REVIEW_PASSED) line=PASSED ;;
          REVIEW_FAILED) line=FAILED ;;
          *) line=UNCLEAR ;;
        esac
      fi
    fi
    eval "SWARM_${upper}_FILE=\$file"
    eval "SWARM_${upper}_VERDICT=\$line"
    [ "$line" = PASSED ] || SWARM_OVERALL=FAILED
  done
}
