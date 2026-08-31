#!/usr/bin/env bash
set -euo pipefail

lenses=(maintainability history structure)

latest_transcript() {
  local pr=$1 lens=$2
  find ops/reviews -maxdepth 1 -type f -name "????????-????-pr${pr}-${lens}.md" \
    -printf '%f\n' 2>/dev/null | LC_ALL=C sort | tail -n 1
}

extract_verdict() {
  awk 'NF { line=$0 } END {
    n=split(line, fields, /[^A-Z_]+/)
    for (i=1; i<=n; i++)
      if (fields[i] == "REVIEW_PASSED" || fields[i] == "REVIEW_FAILED") verdict=fields[i]
    print verdict
  }' "$1"
}

collect_verdicts() {
  local pr=$1 started_at=$2 lens name path verdict
  SWARM_OVERALL=PASSED
  SWARM_SUMMARY=
  SWARM_FILES=()
  for lens in "${lenses[@]}"; do
    name=$(latest_transcript "$pr" "$lens")
    if [[ -z "$name" ]]; then
      verdict=MISSING
      path=
    else
      path="ops/reviews/$name"
      if [[ ! "$path" -nt "$started_at" ]]; then
        verdict=STALE
      else
        verdict=$(extract_verdict "$path")
        [[ -n "$verdict" ]] || verdict=UNCLEAR
      fi
    fi
    [[ "$verdict" == REVIEW_PASSED ]] || SWARM_OVERALL=FAILED
    SWARM_SUMMARY+="${lens}: ${verdict}${path:+ ($path)}"$'\n'
    SWARM_FILES+=("$path")
  done
}

upsert_comment() {
  local anchor=$1 body=$2 comment_id
  comment_id=$(gh api --paginate "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments" \
    --jq ".[] | select(.body | contains(\"$anchor\")) | .id" | head -n 1)
  if [[ -n "$comment_id" ]]; then
    gh api --method PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${comment_id}" -f body="$body" >/dev/null
  else
    gh api --method POST "repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/comments" -f body="$body" >/dev/null
  fi
}

verdict_mode() {
  local pr started_at
  pr=$(<.review-target/pr-number)
  started_at=.review-target/sync-started-at
  collect_verdicts "$pr" "$started_at"
  printf '%s' "$SWARM_SUMMARY"
  [[ "$SWARM_OVERALL" == PASSED ]] && echo SWARM_PASSED || { echo SWARM_FAILED; return 1; }
}

post_mode() {
  local run_id=${1:?usage: swarm-post.sh post RUN_ID TARGET_DIR}
  local target_dir=${2:?usage: swarm-post.sh post RUN_ID TARGET_DIR}
  local lens path body i
  agent-relay cloud sync "$run_id" --dir "$target_dir"
  cd "$target_dir"
  collect_verdicts "$PR_NUMBER" .review-target/sync-started-at
  for i in "${!lenses[@]}"; do
    lens=${lenses[$i]}; path=${SWARM_FILES[$i]}
    body="<!-- swarm-lens: $lens -->"$'\n'
    if [[ -n "$path" ]]; then body+=$(<"$path"); else body+="No fresh transcript was produced."; fi
    upsert_comment "<!-- swarm-lens: $lens -->" "$body"
  done
  body='<!-- review-swarm: marker -->'$'\n'
  body+="Review swarm: **${SWARM_OVERALL}** for run \`${run_id}\`."$'\n\n```\n'
  body+="$SWARM_SUMMARY"$'```'
  upsert_comment '<!-- review-swarm: marker -->' "$body"
}

case ${1:-} in
  verdict) verdict_mode ;;
  post) shift; post_mode "$@" ;;
  *) echo "usage: swarm-post.sh {verdict|post RUN_ID TARGET_DIR}" >&2; exit 2 ;;
esac
