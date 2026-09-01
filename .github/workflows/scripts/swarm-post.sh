#!/bin/sh
# Sync a completed cloud run, evaluate its new transcripts, and upsert the
# marker plus one sticky comment per lens. Posting is best-effort per comment,
# but any posting or verdict failure makes this script fail closed.
set -u

repo_dir=${1:?usage: swarm-post.sh REPO_DIR PR_NUMBER RUN_ID}
pr_number=${2:?usage: swarm-post.sh REPO_DIR PR_NUMBER RUN_ID}
run_id=${3:?usage: swarm-post.sh REPO_DIR PR_NUMBER RUN_ID}
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
. "$script_dir/swarm-verdict.sh"

upsert_comment() {
  anchor=$1
  body_file=$2
  comment_id=$(gh api --paginate "repos/${GITHUB_REPOSITORY}/issues/${pr_number}/comments" \
    --jq ".[] | select(.body | contains(\"$anchor\")) | .id" | head -n 1)
  if [ -n "$comment_id" ]; then
    gh api --method PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${comment_id}" \
      --raw-field "body=$(cat "$body_file")" >/dev/null
  else
    gh pr comment "$pr_number" --body-file "$body_file" >/dev/null
  fi
}

results=$(mktemp)
marker=$(mktemp)
trap 'rm -f "$results" "$marker"' EXIT

verdict_status=0
sync_started=$(date +%s)
sync_status=0
agent-relay cloud sync "$run_id" --dir "$repo_dir" || sync_status=$?
swarm_evaluate "$repo_dir/ops/reviews" "$pr_number" "$sync_started" > "$results" || verdict_status=$?

post_status=0
while IFS="$(printf '\t')" read -r lens verdict transcript; do
  body=$(mktemp)
  {
    printf '<!-- swarm-lens: %s -->\n' "$lens"
    printf '### Review swarm: %s — %s\n\n' "$lens" "$verdict"
    if [ -n "$transcript" ]; then cat "$transcript"; else echo 'No transcript was produced.'; fi
  } > "$body"
  upsert_comment "<!-- swarm-lens: $lens -->" "$body" || post_status=1
  rm -f "$body"
done < "$results"

overall=FAILED
[ "$verdict_status" -eq 0 ] && overall=PASSED
{
  echo '<!-- relayflows-review-swarm -->'
  echo "### Cloud review swarm: $overall"
  echo
  echo "Run: \`$run_id\`"
  echo
  echo 'Immutable-gate controls implemented by this workflow:'
  echo '1. Gate workflow and scripts come from a separate `main` checkout.'
  echo '2. Aggregate and posting source `swarm-verdict.sh`.'
  echo '3. `RELAY_WORKSPACE_KEY` is validated before launch.'
  echo '4. This marker and all three lens comments use sticky anchors.'
  echo '5. The pull-request trigger has no author whitelist.'
  echo '6. PR metadata and diff are fetched on the GHA runner into `.review-target/`.'
  echo '7. Timeouts preserve 75 min > 3900 s > 3600000 ms.'
  echo '8. Wait records status; this post runs under `always()` before the gate fails.'
  echo '9. All transcripts must have been produced after this run sync began.'
  echo
  echo '| Lens | Verdict |'
  echo '|---|---|'
  awk -F '\t' '{ printf "| %s | %s |\n", $1, $2 }' "$results"
} > "$marker"
upsert_comment '<!-- relayflows-review-swarm -->' "$marker" || post_status=1

[ "$sync_status" -eq 0 ] && [ "$verdict_status" -eq 0 ] && [ "$post_status" -eq 0 ]
