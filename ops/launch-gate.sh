#!/bin/sh
# Launch one cloud drive run pinned to a single gate, so several gates can be
# worked in parallel.
#
# `agent-relay cloud run` takes no parameters, but it uploads the working tree
# (--sync-code is the default). So the target is passed as a FILE: each launch
# gets its own worktree containing an ops/TARGET.md naming its gate, and the
# assess step treats that as the operator's scoping decision.
#
# Parallel runs are safe because nothing is delivered from a sandbox: each run
# commits inside its own sandbox and comes back as a separate PR via
# ops/deliver-run.sh. They cannot conflict in flight — only at review time,
# which is where conflicts belong.
#
# Usage: sh ops/launch-gate.sh <gate-number> "<one-line scope>"
set -eu

gate="${1:-}"
scope="${2:-}"

if [ -z "$gate" ] || [ -z "$scope" ]; then
  echo "LAUNCH_FAIL_USAGE: sh ops/launch-gate.sh <gate-number> \"<one-line scope>\"" >&2
  exit 64
fi

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "LAUNCH_FAIL_NOT_A_REPO: $repo_root" >&2
  exit 64
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/flows-gate${gate}.XXXXXX")
git worktree add -q -f --detach "$work" origin/main

cat > "$work/ops/TARGET.md" <<TARGET
# TARGET — gate $gate

This run is pinned to **gate $gate** and must not work on any other gate.

**Scope:** $scope

Several drive runs execute in parallel, each pinned to a different gate. Work
outside this target collides with a sibling run, so staying inside it is not a
preference — it is what makes parallel execution safe.

If gate $gate is genuinely unreachable from the current state, write
ops/NEEDS_HUMAN.md saying exactly why and still end with ASSESS_DONE. Do not
silently substitute different work: a run that reports progress on the wrong
gate is worse than one that reports it is blocked.
TARGET

# The target must be TRACKED. `agent-relay cloud run` uploads the `git ls-files`
# set, so an untracked file is silently not uploaded — which is exactly what
# happened on run 167c2713: ops/TARGET.md never reached the sandbox, the Lead
# never saw its pin, and it picked unrelated self-repair work while reporting
# success. A pin that does not arrive is worse than no pin, because the run
# still looks correctly scoped from outside.
cd "$work"
git add ops/TARGET.md
git -c user.email=lead@relayflows.local -c user.name="Relayflow Lead" \
  commit -q -m "target: pin this run to gate $gate"

if ! git ls-files --error-unmatch ops/TARGET.md >/dev/null 2>&1; then
  echo "LAUNCH_FAIL_TARGET_UNTRACKED: ops/TARGET.md is not tracked, so it would not be uploaded." >&2
  exit 70
fi

echo "LAUNCH_GATE=$gate"
echo "LAUNCH_WORKTREE=$work"
echo "LAUNCH_TARGET_TRACKED=ok"
agent-relay cloud run workflows/drive-cloud.yaml 2>&1 | grep -E "Run created|Status:"
echo "LAUNCH_NOTE: worktree kept at $work — remove with 'git worktree remove --force $work'"
