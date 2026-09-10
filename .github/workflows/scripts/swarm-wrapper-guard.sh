#!/usr/bin/env bash
set -euo pipefail

pr_number=${1:?usage: swarm-wrapper-guard.sh PR_NUMBER}

# Read BOTH filename and previous_filename. A rename of
# `.github/workflows/review-swarm.yml` sets previous_filename to the guarded
# path and filename to the new location, which lets a candidate move the
# wrapper off the branch without failing a `filename`-only check
# (Cursor Bugbot flagged as MEDIUM on #285). Any touch of that path in either
# axis is a modification of the guarded wrapper.
touched_paths=$(gh api --paginate "repos/${GITHUB_REPOSITORY}/pulls/${pr_number}/files" \
  --jq '.[] | .filename, (.previous_filename // empty)')

if grep -Fxq '.github/workflows/review-swarm.yml' <<<"$touched_paths"; then
  echo "candidate changes review-swarm.yml (add, edit, or rename); wrapper enforcement is base-owned and immutable" >&2
  exit 1
fi

echo "REVIEW_SWARM_WRAPPER_GUARD_OK"
