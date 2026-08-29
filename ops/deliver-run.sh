#!/bin/sh
# Turn a completed cloud run into a pull request, from a host that CAN deliver.
#
# Why this exists: a workflow sandbox cannot open a PR. It has no git remote and
# no GitHub token, and the server-side proxy is not available to it either —
# /api/v1/github/pull-request needs either a relayfile sponsor (which rides on
# the auth of whoever LAUNCHED the run, and `agent-relay cloud run` launches
# with a CLI token, so there is none) or CLI auth (which the sandbox lacks).
#
# So delivery happens from a host that already has both: a fleet node or the
# laptop. `agent-relay cloud sync` brings the run's diff here, and ordinary
# git/gh open the PR. No grant, no persona, no proxy.
#
# Usage: sh ops/deliver-run.sh <runId> [repo-dir]
set -eu

run_id="${1:-}"
repo_dir="${2:-$(pwd)}"

if [ -z "$run_id" ]; then
  echo "DELIVER_FAIL_NO_RUN_ID: usage: sh ops/deliver-run.sh <runId> [repo-dir]" >&2
  exit 64
fi

cd "$repo_dir"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "DELIVER_FAIL_NOT_A_REPO: $repo_dir is not a git checkout." >&2
  exit 64
fi
if ! git remote get-url origin >/dev/null 2>&1; then
  echo "DELIVER_FAIL_NO_REMOTE: $repo_dir has no origin remote, so nothing can be pushed." >&2
  exit 75
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "DELIVER_FAIL_NO_GH_AUTH: gh is not authenticated on this host." >&2
  exit 75
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "DELIVER_FAIL_DIRTY_TREE: refusing to apply a run patch over uncommitted changes." >&2
  git status --porcelain | head -10 >&2
  exit 75
fi

git fetch --quiet origin

# Branch from the base the run was LAUNCHED at, not from current main. A run's
# patch is computed against the tree it was given; if main has moved since, the
# patch will not apply. Proved against run f18ec684: its patch was rejected
# with "ops/cargo.sh: patch does not apply" because that file had been rewritten
# on main four times after the run started.
base_ref="${DELIVER_BASE:-origin/main}"
if [ -n "${DELIVER_BASE:-}" ]; then
  echo "DELIVER_BASE_EXPLICIT: $base_ref"
fi

branch="cloud/run-${run_id%%-*}"
git checkout --quiet -B "$branch" "$base_ref"

echo "DELIVER_SYNC: applying run $run_id into $branch"
if ! agent-relay cloud sync "$run_id" --dir "$repo_dir"; then
  echo "DELIVER_FAIL_SYNC: could not apply the run patch onto $base_ref." >&2
  echo "  The usual cause is that main has moved since the run was launched: a run's" >&2
  echo "  patch is computed against the tree it was given. Proved on run f18ec684," >&2
  echo "  whose patch was rejected with 'ops/cargo.sh: patch does not apply' because" >&2
  echo "  that file had been rewritten on main after the run started." >&2
  echo "  Re-run against the launch base:  DELIVER_BASE=<sha> sh ops/deliver-run.sh $run_id" >&2
  echo "  The run's work is still intact in cloud; nothing was pushed." >&2
  exit 75
fi

if git diff --quiet && git diff --cached --quiet; then
  echo "DELIVER_SKIPPED_NO_CHANGES: run $run_id produced no diff against main."
  exit 0
fi

# Never deliver the sandbox's own scaffolding or a materialized toolchain.
# Run f18ec684's patch carried .rustup-home/ toolchain files alongside three
# real source changes; delivering those would put a 20MB toolchain in a PR.
for junk in .workflow-env .rustup-home .rustup .cargo-home .relayflows-toolchain node_modules; do
  rm -rf "$junk" 2>/dev/null || true
done
# Anything still staged from an ignored path is not this tick's work.
git rm -r --cached --quiet --ignore-unmatch \
  .workflow-env .rustup-home .rustup .cargo-home .relayflows-toolchain 2>/dev/null || true

# REFUSE to resurrect files that main deleted. A build step's sandbox can be
# seeded from a stale orchestrator archive: on runs b87c671f and ad7ffc9a the
# build produced kernel/relayflowd/src/engine/hn_poller.rs as a NEW file, which
# PR #16 had deliberately removed from the kernel after review rejected an
# in-kernel HTTP adapter. Both runs looked healthy — completed, BUILD_DONE,
# tests green — and delivering either would have silently reverted a merged
# architectural decision. Only reading the diff caught it, and reading diffs by
# hand is not a control.
resurrected=""
# Check the WORKING TREE, not HEAD. The first version of this guard compared
# "$base_ref"...HEAD and never fired, because at this point the run's patch has
# been applied to the working tree and nothing is committed yet — HEAD is still
# the base, so the diff was always empty. It let PR #17 through with the very
# file it existed to block. A guard that runs before the thing it guards is not
# a guard.
for path in $(git status --porcelain | awk '$1 == "A" || $1 == "??" { print $2 }'); do
  # Was this path deleted from the base's history rather than simply never present?
  if git log --diff-filter=D --format=%H -1 "$base_ref" -- "$path" 2>/dev/null | grep -q .; then
    resurrected="$resurrected $path"
  fi
done
if [ -n "$resurrected" ]; then
  echo "DELIVER_FAIL_RESURRECTED_FILES: this run re-added files that were deliberately deleted:" >&2
  for path in $resurrected; do echo "    $path" >&2; done
  echo "  A build seeded from a stale tree can undo a merged decision without any" >&2
  echo "  failing test. Refusing to open a PR that reverts history." >&2
  echo "  If the re-addition is intentional, deliver with DELIVER_ALLOW_RESURRECT=1." >&2
  [ "${DELIVER_ALLOW_RESURRECT:-0}" = "1" ] || exit 75
  echo "  DELIVER_ALLOW_RESURRECT=1 set — proceeding anyway." >&2
fi

title="drive: cloud run ${run_id%%-*}"
if [ -f ops/NEXT.md ]; then
  wp=$(grep -m1 -oE "WP-[0-9]+[^|]*" ops/NEXT.md 2>/dev/null | sed 's/[[:space:]]*$//' || true)
  [ -n "$wp" ] && title="drive: $wp"
fi

# Restore executable bits the sandbox lost. A workflow sandbox does not
# preserve the exec bit (observed repeatedly: ops/cargo.sh arrived
# non-executable, esbuild failed EACCES), so a patch applied from one carries
# mode 100644 for files git tracks as 100755. Delivering that silently breaks
# every documented `ops/*.sh` invocation — caught by review on PR #13, where
# ops/cargo.sh landed as 100644 against main's 100755.
#
# Trust the BASE's recorded modes, not the sandbox's filesystem.
git add -A
for tracked in $(git ls-tree -r "$base_ref" --format='%(objectmode) %(path)' \
                | awk '$1 == "100755" { print $2 }'); do
  if [ -f "$tracked" ]; then
    chmod +x "$tracked" 2>/dev/null || true
    git update-index --chmod=+x "$tracked" 2>/dev/null || true
  fi
done
git add -A
git commit --quiet -m "$title

Work produced by cloud run $run_id in a workflow sandbox and delivered from
this host, because a sandbox has no remote and no GitHub token.

Verification and adversarial review ran in-run; see ops/reviews/ in the diff."

git push --quiet -u origin "$branch"
gh pr create --fill --body "Automated drive work from cloud run \`$run_id\`.

The sandbox cannot open PRs (no remote, no GitHub token), so this was delivered
from a host that can. Verification and adversarial review ran in-run — see
\`ops/reviews/\` in the diff. **A human merges.**" 2>&1 | tail -2
echo "DELIVER_PR_OPENED for run $run_id on $branch"
