#!/bin/sh
set -eu

run_id=$1
pr=$2
repo=$3
worktree=$4
sync_started=$(date +%s)

agent-relay cloud sync "$run_id" --dir "$worktree"
cd "$worktree"
. .review-target/swarm-verdict.sh

post_sticky() {
  anchor=$1
  body_file=$2
  comment_id=$(gh api --paginate "repos/$repo/issues/$pr/comments" \
    --jq ".[] | select(.body | contains(\"$anchor\")) | .id" | head -n 1)
  if [ -n "$comment_id" ]; then
    gh api --method PATCH "repos/$repo/issues/comments/$comment_id" \
      --raw-field "body=$(cat "$body_file")" >/dev/null
  else
    gh pr comment "$pr" --repo "$repo" --body-file "$body_file" >/dev/null
  fi
}

failed=0
for lens in $SWARM_LENSES; do
  transcript=$(swarm_latest_transcript "$pr" "$lens" ops/reviews)
  if [ -z "$transcript" ] || [ "$(stat -c %Y "$transcript")" -lt "$sync_started" ]; then
    echo "POST_FAILED: $lens transcript is missing or stale" >&2
    failed=1
    continue
  fi
  body=$(mktemp)
  printf '<!-- swarm-lens: %s -->\n' "$lens" > "$body"
  cat "$transcript" >> "$body"
  post_sticky "<!-- swarm-lens: $lens -->" "$body"
  rm -f "$body"
done

marker=$(mktemp)
if [ "$failed" -eq 0 ] && swarm_evaluate "$pr" ops/reviews; then
  printf '%s\n%s\n' '<!-- review-swarm -->' '🎯 review-swarm: PASSED' > "$marker"
else
  failed=1
  printf '%s\n%s\n' '<!-- review-swarm -->' '🛑 review-swarm: FAILED' > "$marker"
fi
post_sticky '<!-- review-swarm -->' "$marker"
rm -f "$marker"
[ "$failed" -eq 0 ]
