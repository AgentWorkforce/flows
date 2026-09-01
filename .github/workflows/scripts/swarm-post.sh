#!/usr/bin/env bash
set -euo pipefail

pr=${1:?usage: swarm-post.sh PR_NUMBER RUN_ID SYNC_DIR SYNC_STARTED_EPOCH}
run_id=${2:?usage: swarm-post.sh PR_NUMBER RUN_ID SYNC_DIR SYNC_STARTED_EPOCH}
sync_dir=${3:?usage: swarm-post.sh PR_NUMBER RUN_ID SYNC_DIR SYNC_STARTED_EPOCH}
sync_started=${4:?usage: swarm-post.sh PR_NUMBER RUN_ID SYNC_DIR SYNC_STARTED_EPOCH}
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$script_dir/swarm-verdict.sh"

review_dir="$sync_dir/ops/reviews"
overall=FAILED
if swarm_evaluate "$review_dir" "$pr" "$sync_started"; then overall=PASSED; fi

upsert_comment() {
  local anchor=$1 body=$2 id
  id=$(gh api --paginate "repos/{owner}/{repo}/issues/$pr/comments" \
    --jq ".[] | select(.body | contains(\"$anchor\")) | .id" | head -n 1)
  if [ -n "$id" ]; then
    gh api --method PATCH "repos/{owner}/{repo}/issues/comments/$id" -f body="$body" >/dev/null
  else
    gh api --method POST "repos/{owner}/{repo}/issues/$pr/comments" -f body="$body" >/dev/null
  fi
}

while IFS='|' read -r lens verdict path; do
  [ -n "$lens" ] || continue
  anchor="<!-- swarm-lens: $lens -->"
  if [ -n "$path" ] && [ -f "$path" ]; then
    transcript=$(cat "$path")
  else
    transcript="No transcript was produced for this lens."
  fi
  upsert_comment "$anchor" "$anchor
### Review swarm: $lens — $verdict

$transcript"
done <<< "$SWARM_RESULTS"

marker='<!-- review-swarm -->'
upsert_comment "$marker" "$marker
### Review swarm: $overall

Cloud run: \`$run_id\`. All three lenses must end in \`REVIEW_PASSED\`; missing, unclear, failed, or stale transcripts fail closed."

[ "$overall" = PASSED ]
