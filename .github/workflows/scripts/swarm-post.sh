#!/usr/bin/env bash
set -euo pipefail

run_id=${1:?usage: swarm-post.sh RUN_ID PR_NUMBER}
pr=${2:?usage: swarm-post.sh RUN_ID PR_NUMBER}
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=swarm-verdict.sh
source "$script_dir/swarm-verdict.sh"

freshness_marker=$(mktemp)
trap 'rm -f "$freshness_marker"' EXIT
agent-relay cloud sync "$run_id" --dir .

upsert_comment() {
  local anchor=$1 body=$2 comment_id
  comment_id=$(gh api --paginate "repos/{owner}/{repo}/issues/$pr/comments" \
    --jq ".[] | select(.body | contains(\"$anchor\")) | .id" | head -n 1)
  if [ -n "$comment_id" ]; then
    gh api --method PATCH "repos/{owner}/{repo}/issues/comments/$comment_id" -f body="$body" >/dev/null
  else
    gh pr comment "$pr" --body "$body" >/dev/null
  fi
}

overall=PASSED
summary=''
for lens in maintainability history structure; do
  IFS=$'\t' read -r verdict transcript < <(
    swarm_lens_result ops/reviews "$pr" "$lens" "$freshness_marker"
  )
  [ "$verdict" = PASSED ] || overall=FAILED
  summary+="- ${lens}: ${verdict}"$'\n'
  if [ -n "$transcript" ] && [ -f "$transcript" ]; then
    body="<!-- swarm-lens: $lens -->
## Review swarm: $lens

$(cat "$transcript")"
  else
    body="<!-- swarm-lens: $lens -->
## Review swarm: $lens

No fresh transcript was produced for run \`$run_id\` ($verdict)."
  fi
  upsert_comment "<!-- swarm-lens: $lens -->" "$body"
done

upsert_comment '<!-- review-swarm -->' "<!-- review-swarm -->
## Review swarm: $overall

$summary
Cloud run: \`$run_id\`"

[ "$overall" = PASSED ]
