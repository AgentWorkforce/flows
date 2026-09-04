#!/usr/bin/env bash
set -euo pipefail

run_id=${1:?usage: swarm-post.sh RUN_ID PR_NUMBER PR_CHECKOUT}
pr_number=${2:?usage: swarm-post.sh RUN_ID PR_NUMBER PR_CHECKOUT}
pr_checkout=${3:?usage: swarm-post.sh RUN_ID PR_NUMBER PR_CHECKOUT}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
reviews_dir="$pr_checkout/ops/reviews"
sync_started=$(date +%s)

# shellcheck source=swarm-verdict.sh
. "$script_dir/swarm-verdict.sh"

agent-relay cloud sync "$run_id" --dir "$pr_checkout"

upsert_comment() {
  local anchor=$1 body=$2 comment_id
  comment_id=$(gh api --paginate \
    "repos/${GITHUB_REPOSITORY}/issues/${pr_number}/comments" \
    | jq -s -r --arg anchor "$anchor" \
      'add | map(select(.body | contains($anchor))) | last | .id // empty')
  if [ -n "$comment_id" ]; then
    gh api -X PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${comment_id}" \
      -f body="$body" >/dev/null
  else
    gh api -X POST "repos/${GITHUB_REPOSITORY}/issues/${pr_number}/comments" \
      -f body="$body" >/dev/null
  fi
}

overall=PASSED
summary=''
for lens in maintainability history structure; do
  result=$(swarm_evaluate_lens "$reviews_dir" "$pr_number" "$lens" "$sync_started") || true
  IFS=$'\t' read -r state transcript verdict <<< "$result"
  [ "$state" = PASSED ] || overall=FAILED
  summary="${summary}- ${lens}: ${state}\n"

  if [ -n "${transcript:-}" ] && [ -f "$transcript" ]; then
    content=$(<"$transcript")
  else
    content="No fresh transcript was produced for this run (${state})."
  fi
  upsert_comment "<!-- swarm-lens: ${lens} -->" \
    "<!-- swarm-lens: ${lens} -->
### Review swarm: ${lens}

${content}"
done

upsert_comment '<!-- swarm-marker -->' \
  "<!-- swarm-marker -->
### Review swarm: ${overall}

Cloud run: \`${run_id}\`

$(printf '%b' "$summary")"

printf 'swarm verdict: %s\n' "$overall"
