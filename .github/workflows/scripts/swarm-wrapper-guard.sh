#!/usr/bin/env bash
set -euo pipefail

pr_number=${1:?usage: swarm-wrapper-guard.sh PR_NUMBER}

# These are the base-owned control-plane files that can change how a review is
# judged. `workflows/review-swarm.yaml` is deliberately absent: candidates may
# propose a new definition, but swarm-definition.sh validates its policy while
# the trusted base definition remains the one that actually runs.
protected_paths=(
  '.github/workflows/review-swarm.yml'
  '.github/workflows/review-swarm-wrapper-guard.yml'
  '.github/workflows/scripts/swarm-wrapper-guard.sh'
  '.github/workflows/scripts/swarm-gate.test.sh'
  '.github/workflows/scripts/swarm-definition.sh'
  '.github/workflows/scripts/swarm-definition.test.sh'
  '.github/workflows/scripts/swarm-status-diagnostic.sh'
  '.github/workflows/scripts/swarm-status-diagnostic.test.sh'
  '.github/workflows/scripts/swarm-prepare.sh'
  '.github/workflows/scripts/swarm-post.sh'
  '.github/workflows/scripts/swarm-verdict.sh'
  '.github/workflows/scripts/swarm-wrapper-guard.test.sh'
  '.github/workflows/scripts/review-swarm-workflow.test.sh'
)

set_result() {
  local result=$1
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'guard_result=%s\n' "$result" >>"$GITHUB_OUTPUT"
  fi
}

# Read BOTH filename and previous_filename. A rename sets previous_filename to
# the protected path and filename to the new location, so a filename-only check
# lets a candidate move a gate file away. Any add, edit, delete, or rename of a
# protected path is blocked. If GitHub cannot return the file list, preserve an
# infrastructure failure result rather than calling it a candidate rejection.
if ! touched_paths=$(gh api --paginate "repos/${GITHUB_REPOSITORY}/pulls/${pr_number}/files" \
  --jq '.[] | .filename, (.previous_filename // empty)'); then
  set_result error
  echo "could not inspect changed files for review-swarm guard" >&2
  exit 1
fi

for protected_path in "${protected_paths[@]}"; do
  if grep -Fqx -- "$protected_path" <<<"$touched_paths"; then
    set_result rejected
    echo "candidate changes base-owned review-swarm gate file: $protected_path" >&2
    exit 1
  fi
done

set_result clean
echo "REVIEW_SWARM_WRAPPER_GUARD_OK"
