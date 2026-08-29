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

# REFUSE paths that a human or a review has ruled out. See ops/FORBIDDEN_PATHS
# for why this is a list rather than a git-history check: the file that
# triggered it was never on main, so there was no deletion to detect, and three
# runs resurrected it from stale sandbox trees while every gate stayed green.
# Read the list from origin/main, NOT from the working tree. This script
# checks out $base_ref, and a base older than the list means the file is simply
# absent — which is how the first version of this check silently skipped: it
# tested [ -f ops/FORBIDDEN_PATHS ] against a base predating the list.
forbidden_rules=$(git show origin/main:ops/FORBIDDEN_PATHS 2>/dev/null || true)
if [ -z "$forbidden_rules" ]; then
  # A missing denylist means NO protection. Say so; never skip in silence.
  echo "DELIVER_FAIL_NO_DENYLIST: could not read ops/FORBIDDEN_PATHS from origin/main." >&2
  echo "  Delivery refuses rather than proceeding unguarded — a guard that skips" >&2
  echo "  quietly is how the previous two versions of this check let PR #17 through." >&2
  exit 70
fi

violations=""
changed=$(git status --porcelain | sed 's/^...//')
printf '%s\n' "$forbidden_rules" | while IFS= read -r pattern; do
  case "$pattern" in ''|'#'*) continue ;; esac
  for path in $changed; do
    case "$path" in
      "$pattern"*) echo "$path" ;;
    esac
  done
done > /tmp/.deliver-violations.$$ 2>/dev/null || true
violations=$(cat /tmp/.deliver-violations.$$ 2>/dev/null | sort -u)
rm -f /tmp/.deliver-violations.$$
if [ -n "$violations" ]; then
  echo "DELIVER_FAIL_FORBIDDEN_PATH: this run touched paths ruled out in ops/FORBIDDEN_PATHS:" >&2
  for path in $violations; do echo "    $path" >&2; done
  echo "  These are decisions that review already made. A build seeded from a stale" >&2
  echo "  tree can undo them with every test still green, so delivery refuses rather" >&2
  echo "  than relying on someone reading the diff." >&2
  echo "  If the change is genuinely intended, remove the entry from ops/FORBIDDEN_PATHS" >&2
  echo "  in a commit that explains why, or set DELIVER_ALLOW_FORBIDDEN=1 for one run." >&2
  [ "${DELIVER_ALLOW_FORBIDDEN:-0}" = "1" ] || exit 75
  echo "  DELIVER_ALLOW_FORBIDDEN=1 set — proceeding anyway." >&2
fi

# A work package is not work. If the only substantive change is ops/NEXT.md,
# this run assessed and produced nothing — either it genuinely had nothing to
# build, or its code was lost by the capture fault. Opening a PR for that adds
# review noise and, run unattended, accumulates it steadily.
substantive=$(git status --porcelain | sed 's/^...//' | grep -vE '^(ops/NEXT\.md|ops/TARGET\.md)$' | head -1)
if [ -z "$substantive" ]; then
  echo "DELIVER_SKIPPED_ASSESSMENT_ONLY: the only change is a work package, not work."
  echo "  Either the run had nothing to build, or its code did not survive capture."
  echo "  Not opening a PR for a NEXT.md edit."
  exit 0
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
