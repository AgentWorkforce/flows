#!/usr/bin/env bash
# Prepare the .review-target/ packet the cloud review swarm consumes.
#
# The cloud sandbox has NO GitHub token and NO git remote — the earlier
# workflow tried to run `gh pr view/diff` from inside the sandbox and got
# 0-line diffs because gh was unauthenticated ("To get started with GitHub
# CLI, please run: gh auth login"). This helper runs on the LAUNCHING host
# (GitHub Actions runner, or your laptop), where `gh` IS authenticated,
# and drops the diff + metadata into `.review-target/` so `agent-relay
# cloud run` uploads them like any other tracked file.
#
# Files written (all consumed by workflows/review-swarm.yaml):
#   .review-target/pr-number     one-line PR number
#   .review-target/pr.diff       output of `gh pr diff <PR>`
#   .review-target/pr.json       output of `gh pr view <PR> --json ...`
#
# Usage:
#   scripts/review-swarm-prepare.sh <PR_NUMBER>
# Then:
#   agent-relay cloud run workflows/review-swarm.yaml
set -euo pipefail

pr="${1:-}"
if [[ -z "$pr" || ! "$pr" =~ ^[0-9]+$ ]]; then
  echo "usage: $0 <PR_NUMBER>" >&2
  exit 2
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "PREPARE_FAILED: gh not on PATH — the launching host must have GitHub CLI." >&2
  exit 3
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "PREPARE_FAILED: gh is unauthenticated on this host." >&2
  echo "  Either run \`gh auth login\` or export GH_TOKEN (CI does the latter)." >&2
  exit 4
fi

mkdir -p .review-target
printf '%s\n' "$pr" > .review-target/pr-number

# `gh pr diff` and `gh pr view` both fail loudly on missing PRs — do NOT
# swallow their exit code. The earlier workflow ran `gh` under `set -u` only
# and reported FETCHED with 0 lines when gh failed.
gh pr diff "$pr" > .review-target/pr.diff
gh pr view "$pr" --json number,headRefName,baseRefName,title,url,author \
  > .review-target/pr.json

diff_lines=$(wc -l < .review-target/pr.diff | tr -d ' ')
if [[ "$diff_lines" -eq 0 ]]; then
  echo "PREPARE_FAILED: gh pr diff $pr produced 0 lines — refusing to stage a nothing-review." >&2
  exit 5
fi

# Stage so `agent-relay cloud run` (which uploads `git ls-files`) picks them
# up. `.review-target/` is no longer in .gitignore, so plain `git add` works.
git add .review-target/pr-number .review-target/pr.diff .review-target/pr.json

echo "PREPARED: PR #$pr, $diff_lines diff lines, staged for upload"
