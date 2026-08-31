#!/bin/sh
set -u

run_id=${1:?usage: swarm-post.sh RUN_ID PR_NUMBER WORKTREE}
pr_number=${2:?usage: swarm-post.sh RUN_ID PR_NUMBER WORKTREE}
worktree=${3:?usage: swarm-post.sh RUN_ID PR_NUMBER WORKTREE}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$script_dir/swarm-verdict.sh"

sync_started=$(date +%s)
sync_ok=true
if ! agent-relay cloud sync "$run_id" --dir "$worktree"; then
  sync_ok=false
fi

verdict_file=$(mktemp)
trap 'rm -f "$verdict_file"' EXIT
if [ "$sync_ok" = true ]; then
  swarm_overall_verdict "$worktree/ops/reviews" "$pr_number" "$sync_started" \
    > "$verdict_file" || true
else
  for lens in $swarm_lenses; do printf '%s\tMISSING\t\n' "$lens"; done > "$verdict_file"
  printf 'overall\tFAILED\n' >> "$verdict_file"
fi

upsert_comment() {
  anchor=$1
  body_file=$2
  comment_id=$(gh api "repos/$GITHUB_REPOSITORY/issues/$pr_number/comments" --paginate \
    --jq ".[] | select(.body | contains(\"$anchor\")) | .id" | head -n 1)
  if [ -n "$comment_id" ]; then
    gh api --method PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$comment_id" \
      --input "$body_file" >/dev/null
  else
    gh api --method POST "repos/$GITHUB_REPOSITORY/issues/$pr_number/comments" \
      --input "$body_file" >/dev/null
  fi
}

while IFS="$(printf '\t')" read -r lens verdict name; do
  [ "$lens" != overall ] || continue
  body=$(mktemp)
  {
    printf '{"body":'
    { printf '<!-- swarm-lens: %s -->\n### Review swarm: %s — %s\n\n' "$lens" "$lens" "$verdict"
      if [ -n "$name" ] && [ -f "$worktree/ops/reviews/$name" ]; then
        cat "$worktree/ops/reviews/$name"
      else
        printf 'No fresh transcript was produced by run `%s`.\n' "$run_id"
      fi
    } | jq -Rs .
    printf '}\n'
  } > "$body"
  upsert_comment "<!-- swarm-lens: $lens -->" "$body"
  rm -f "$body"
done < "$verdict_file"

overall=$(awk -F '\t' '$1 == "overall" { print $2 }' "$verdict_file")
marker=$(mktemp)
printf '<!-- review-swarm -->\n### Review swarm: %s\n\nRun `%s`; all three lenses must pass.\n' \
  "$overall" "$run_id" | jq -Rs '{body: .}' > "$marker"
upsert_comment '<!-- review-swarm -->' "$marker"
rm -f "$marker"
