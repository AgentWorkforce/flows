#!/usr/bin/env bash
set -euo pipefail

lenses=(maintainability history structure)

select_transcript() {
  local pr=$1 lens=$2 file
  file=$(find ops/reviews -maxdepth 1 -type f -name "????????-????-pr${pr}-${lens}.md" -print 2>/dev/null |
    LC_ALL=C sort | tail -n 1)
  printf '%s' "$file"
}

transcript_verdict() {
  local file=$1
  awk 'NF { line=$0 } END {
    n=split(line, fields, /[^A-Z_]+/)
    for (i=1; i<=n; i++)
      if (fields[i] == "REVIEW_PASSED" || fields[i] == "REVIEW_FAILED") verdict=fields[i]
    print verdict
  }' "$file"
}

collect_verdicts() {
  local pr=$1 sync_started=$2 lens file verdict
  overall=PASSED
  transcript_files=()
  transcript_verdicts=()
  for lens in "${lenses[@]}"; do
    file=$(select_transcript "$pr" "$lens")
    verdict=MISSING
    if [ -n "$file" ] && [ "$file" -nt "$sync_started" ]; then
      verdict=$(transcript_verdict "$file")
      [ -n "$verdict" ] || verdict=UNCLEAR
      transcript_files+=("$file")
    else
      transcript_files+=("")
    fi
    transcript_verdicts+=("$verdict")
    if [ "$verdict" != REVIEW_PASSED ]; then overall=FAILED; fi
    echo "$lens: $verdict${file:+ ($file)}"
  done
  echo "overall: $overall"
}

upsert_comment() {
  local anchor=$1 body_file=$2 comment_id
  comment_id=$(gh api --paginate "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments" \
    --jq ".[] | select(.body | contains(\"$anchor\")) | .id" | head -n 1)
  if [ -n "$comment_id" ]; then
    gh api --method PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/$comment_id" \
      -F body=@"$body_file" >/dev/null
  else
    gh api --method POST "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments" \
      -F body=@"$body_file" >/dev/null
  fi
}

if [ "${1:-}" = --aggregate ]; then
  pr=$(tr -dc '0-9' < .review-target/pr-number)
  sync_started=.review-target/sync-started
  [ -n "$pr" ] || { echo "SWARM_FAILED: missing PR number"; exit 1; }
  [ -f "$sync_started" ] || { echo "SWARM_FAILED: missing sync marker"; exit 1; }
  collect_verdicts "$pr" "$sync_started"
  [ "$overall" = PASSED ] && echo SWARM_PASSED || exit 1
  exit 0
fi

: "${RUN_ID:?RUN_ID is required}"
: "${SWARM_STATUS:?SWARM_STATUS is required}"
agent-relay cloud sync "$RUN_ID"
pr=$(tr -dc '0-9' < .review-target/pr-number)
sync_started=.review-target/sync-started
[ -n "$pr" ] || { echo "SWARM_FAILED: missing PR number"; exit 1; }
[ -f "$sync_started" ] || { echo "SWARM_FAILED: missing sync marker"; exit 1; }
collect_verdicts "$pr" "$sync_started"

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
for i in "${!lenses[@]}"; do
  lens=${lenses[$i]}
  file=${transcript_files[$i]}
  {
    echo "<!-- swarm-lens: $lens -->"
    echo "## Review swarm: $lens"
    echo
    if [ -n "$file" ]; then cat "$file"; else echo "No fresh transcript was produced."; fi
  } > "$tmp_dir/$lens.md"
  upsert_comment "<!-- swarm-lens: $lens -->" "$tmp_dir/$lens.md"
done

{
  echo '<!-- review-swarm -->'
  echo '## Review swarm status'
  echo
  echo "Cloud run: \`$RUN_ID\`"
  echo "Terminal status: \`$SWARM_STATUS\`"
  echo "Verdict: **$overall**"
} > "$tmp_dir/marker.md"
upsert_comment '<!-- review-swarm -->' "$tmp_dir/marker.md"

[ "$SWARM_STATUS" = completed ] && [ "$overall" = PASSED ]
