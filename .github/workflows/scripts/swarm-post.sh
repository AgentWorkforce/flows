#!/bin/sh
set -eu

lenses="maintainability history structure"

latest_transcript() {
  review_dir=$1
  pr=$2
  lens=$3
  find "$review_dir" -maxdepth 1 -type f -name "*-pr${pr}-${lens}.md" \
    -printf '%f\n' 2>/dev/null | LC_ALL=C sort | tail -n 1
}

transcript_verdict() {
  file=$1
  token=$(awk 'NF { last=$NF } END { print last }' "$file")
  case "$token" in
    REVIEW_PASSED) printf '%s\n' PASSED ;;
    REVIEW_FAILED) printf '%s\n' FAILED ;;
    *) printf '%s\n' UNCLEAR ;;
  esac
}

collect_verdicts() {
  root=$1
  pr=$2
  started_file="$root/.review-target/sync-start"
  review_dir="$root/ops/reviews"
  overall=PASSED

  if [ ! -f "$started_file" ]; then
    echo "MISSING|sync-start|MISSING"
    return 1
  fi
  started=$(cat "$started_file")

  for lens in $lenses; do
    name=$(latest_transcript "$review_dir" "$pr" "$lens")
    if [ -z "$name" ]; then
      echo "$lens||MISSING"
      overall=FAILED
      continue
    fi
    file="$review_dir/$name"
    modified=$(stat -c %Y "$file")
    if [ "$modified" -lt "$started" ]; then
      verdict=STALE
    else
      verdict=$(transcript_verdict "$file")
    fi
    [ "$verdict" = PASSED ] || overall=FAILED
    echo "$lens|$file|$verdict"
  done
  [ "$overall" = PASSED ]
}

run_verdict() {
  root=${1:-.}
  pr=$(tr -dc '0-9' < "$root/.review-target/pr-number")
  verdicts=$(collect_verdicts "$root" "$pr") && overall=PASSED || overall=FAILED
  printf '%s\n' "$verdicts"
  echo "OVERALL|$overall"
  [ "$overall" = PASSED ]
}

upsert_comment() {
  anchor=$1
  body_file=$2
  comment_id=$(gh api --paginate "repos/$GH_REPO/issues/$PR_NUMBER/comments" \
    --jq ".[] | select(.body | contains(\"$anchor\")) | .id" | tail -n 1)
  if [ -n "$comment_id" ]; then
    gh api --method PATCH "repos/$GH_REPO/issues/comments/$comment_id" \
      --raw-field "body=$(cat "$body_file")" >/dev/null
  else
    gh api --method POST "repos/$GH_REPO/issues/$PR_NUMBER/comments" \
      --raw-field "body=$(cat "$body_file")" >/dev/null
  fi
}

post_results() {
  root=${1:-.}
  : "${RUN_ID:?RUN_ID is required}"
  : "${SWARM_STATUS:?SWARM_STATUS is required}"
  : "${GH_REPO:?GH_REPO is required}"
  : "${PR_NUMBER:?PR_NUMBER is required}"

  sync_status=ok
  agent-relay cloud sync "$RUN_ID" --dir "$root" || sync_status=failed
  verdicts=$(run_verdict "$root") && overall=PASSED || overall=FAILED
  [ "$SWARM_STATUS" = completed ] || overall=FAILED
  [ "$sync_status" = ok ] || overall=FAILED

  temp_dir=$(mktemp -d)
  trap 'rm -rf "$temp_dir"' EXIT HUP INT TERM
  printf '%s\n' "$verdicts" | while IFS='|' read -r lens file verdict; do
    case "$lens" in
      maintainability|history|structure) ;;
      *) continue ;;
    esac
    body="$temp_dir/$lens.md"
    printf '<!-- swarm-lens: %s -->\n### Review swarm: %s — %s\n\n' \
      "$lens" "$lens" "$verdict" > "$body"
    if [ -n "$file" ] && [ -f "$file" ]; then
      cat "$file" >> "$body"
    else
      echo "No current transcript was produced." >> "$body"
    fi
    upsert_comment "<!-- swarm-lens: $lens -->" "$body"
  done

  marker="$temp_dir/marker.md"
  cat > "$marker" <<EOF
<!-- review-swarm -->
### Review swarm: $overall

Cloud run: \`$RUN_ID\`  
Terminal status: \`$SWARM_STATUS\`  
Evidence sync: \`$sync_status\`

Gate contract: (1) judge files come from main; (2) one verdict implementation;
(3) auth is preflighted; (4) marker and lens comments are sticky; (5) every PR
is reviewed; (6) PR data is fetched on the launching host; (7) timeouts obey
75m > 65m > 60m; (8) terminal status is recorded before always-post and gating;
(9) all three transcripts must be newer than the cloud sync start.
EOF
  upsert_comment '<!-- review-swarm -->' "$marker"
  [ "$overall" = PASSED ]
}

case ${1:-} in
  verdict) shift; run_verdict "$@" ;;
  post) shift; post_results "$@" ;;
  *) echo "usage: $0 {verdict [root]|post [root]}" >&2; exit 64 ;;
esac
