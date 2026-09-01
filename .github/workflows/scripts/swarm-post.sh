#!/usr/bin/env bash
set -euo pipefail

lenses=(maintainability history structure)

latest_transcript() {
  local root=$1 pr=$2 lens=$3
  find "$root/ops/reviews" -maxdepth 1 -type f \
    -name "*-pr${pr}-${lens}.md" -printf '%f\n' 2>/dev/null | sort | tail -n 1
}

transcript_verdict() {
  local file=$1 started=$2 last
  [ -n "$file" ] && [ -f "$file" ] || { printf 'MISSING\n'; return; }
  [ "$(stat -c %Y "$file")" -ge "$started" ] || { printf 'STALE\n'; return; }
  last=$(sed '/^[[:space:]]*$/d' "$file" | tail -n 1)
  case "$last" in
    *REVIEW_PASSED) printf 'PASSED\n' ;;
    *REVIEW_FAILED) printf 'FAILED\n' ;;
    *) printf 'UNCLEAR\n' ;;
  esac
}

evaluate() {
  local root=$1 pr started lens name file verdict overall=PASSED
  pr=$(tr -d '[:space:]' < "$root/.review-target/pr-number")
  started=$(tr -d '[:space:]' < "$root/.review-target/sync-started")
  for lens in "${lenses[@]}"; do
    name=$(latest_transcript "$root" "$pr" "$lens")
    file=${name:+$root/ops/reviews/$name}
    verdict=$(transcript_verdict "$file" "$started")
    printf '%s\t%s\t%s\n' "$lens" "$verdict" "$file"
    [ "$verdict" = PASSED ] || overall=FAILED
  done
  printf 'overall\t%s\n' "$overall"
  [ "$overall" = PASSED ]
}

upsert_comment() {
  local anchor=$1 body=$2 id
  id=$(gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/comments" \
    --jq ".[] | select(.body | contains(\"$anchor\")) | .id" | sed -n '1p')
  if [ -n "$id" ]; then
    gh api --method PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$id" -f body="$body" >/dev/null
  else
    gh api --method POST "repos/$GITHUB_REPOSITORY/issues/$PR_NUMBER/comments" -f body="$body" >/dev/null
  fi
}

post() {
  local root=$1 report rc lens verdict file anchor body overall sync_rc=0
  agent-relay cloud sync "$RUN_ID" --dir "$root" || sync_rc=$?
  report=$(mktemp)
  rc=$sync_rc
  evaluate "$root" > "$report" || rc=$?
  for lens in "${lenses[@]}"; do
    IFS=$'\t' read -r _ verdict file < <(awk -F '\t' -v lens="$lens" '$1 == lens { print; exit }' "$report")
    anchor="<!-- swarm-lens: $lens -->"
    if [ "$verdict" = PASSED ] || [ "$verdict" = FAILED ]; then
      body=$(printf '%s\n\n%s' "$anchor" "$(cat "$file")")
    else
      body=$(printf '%s\n\nReview evidence is %s for cloud run `%s`.' "$anchor" "$verdict" "$RUN_ID")
    fi
    upsert_comment "$anchor" "$body"
  done
  overall=$(awk -F '\t' '$1 == "overall" { print $2 }' "$report")
  [ "${SWARM_STATUS:-}" = completed ] || overall=FAILED
  anchor='<!-- review-swarm: marker -->'
  body=$(printf '%s\n\nReview swarm **%s** for cloud run `%s` (terminal status: `%s`).' \
    "$anchor" "$overall" "$RUN_ID" "${SWARM_STATUS:-unknown}")
  upsert_comment "$anchor" "$body"
  rm -f "$report"
  return "$rc"
}

case "${1:-}" in
  verdict) evaluate "${2:-.}" ;;
  post) post "${2:?usage: swarm-post.sh post TARGET_DIR}" ;;
  *) echo "usage: swarm-post.sh verdict [ROOT] | post TARGET_DIR" >&2; exit 2 ;;
esac
