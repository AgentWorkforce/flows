#!/bin/bash
# Factory driver — the authoring loop that produces PRs against
# AgentWorkforce/flows by spawning Claude Code agents on
# agent-relay. See ops/factory/README.md for the full picture.
#
# Runs continuously until FACTORY_ITERATION_CAP is hit or SIGINT.
# Each iteration:
#   1. Claims up to FACTORY_MAX_WORKERS unclaimed tasks from
#      queue.md (serialized by the single DRIVER_LOCK and the
#      inherently sequential outer loop; no queue-file lock).
#   2. Spawns ops/factory/spawn-worker.sh for each in the background.
#   3. Waits for all to complete.
#   4. Rewrites queue.md with their results (- [x] or - [!]).
#   5. Loops.
#
# The post-push review-swarm and auto-merge launchd loops handle the
# rest — this driver just gets PRs OPENED.

set -eu

# --- Refused-path source of truth --------------------------------
# The self-modification rail refuses any PR whose diff touches
# these paths. brief-template.md rule #2, queue.md rules, README
# §"Self-modification rail", and the `forbidden=` grep below all
# read from THIS enumeration by textual reference (see the
# comment above the grep). If you change the list, change it
# HERE, then update the three doc files to name the same paths.
# The list is short by design; if it grows, factor a shared
# `ops/factory/lib/refused-paths.sh` and source it everywhere.
#
# Current refused paths:
#   ops/factory/**                     (driver, briefs, template)
#   ops/preswarm-check/**              (local pre-swarm runner)
#   workflows/preswarm-check.yaml      (pre-swarm workflow)

FACTORY_MAX_WORKERS=${FACTORY_MAX_WORKERS:-3}
FACTORY_ITERATION_CAP=${FACTORY_ITERATION_CAP:-50}
FACTORY_NODE=${FACTORY_NODE:-sf-mini}
FACTORY_LOG_DIR=${FACTORY_LOG_DIR:-/tmp}
FACTORY_ROOT=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$FACTORY_ROOT/../.." && pwd)
QUEUE_FILE="$FACTORY_ROOT/queue.md"
# Stranded `- [~]` claims older than this get reset to `- [ ]` at
# driver startup. The threshold is generous — a real worker on a
# real task can take 30–60 min. Set STRAND_MAX_AGE_SECONDS in the
# env to tune (0 disables reclamation, useful for a debug run).
STRAND_MAX_AGE_SECONDS=${STRAND_MAX_AGE_SECONDS:-7200}

if [ ! -f "$QUEUE_FILE" ]; then
  echo "driver: no queue file at $QUEUE_FILE" >&2
  exit 2
fi

# Top-level driver lockfile. Two concurrent driver instances would
# race on queue-line claims and produce duplicate PRs. Refuse to
# start when another driver is holding this file. A stale lock from
# a crashed prior run is diagnosed loudly rather than silently
# stolen — the operator must remove it.
DRIVER_LOCK="${FACTORY_LOG_DIR}/factory-driver.lock"
# `set -C` (noclobber) makes `>` refuse to overwrite an existing
# file — the create-if-absent becomes atomic in the shell itself,
# closing the TOCTOU between an `[ -f ]` check and the write.
# Restore normal clobber semantics after the lock is claimed.
(
  set -C
  printf 'pid=%s started=%s\n' "$$" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$DRIVER_LOCK"
) 2>/dev/null || {
  echo "driver: refusing to start — lock $DRIVER_LOCK already exists (another driver running or a crashed prior run)." >&2
  echo "driver: if you're sure no other driver is live: rm '$DRIVER_LOCK' and re-run." >&2
  exit 3
}
trap 'rm -f "$DRIVER_LOCK"' EXIT
trap 'rm -f "$DRIVER_LOCK"; exit 130' INT
trap 'rm -f "$DRIVER_LOCK"; exit 143' TERM

# NO queue-file lock. The DRIVER_LOCK above already serializes
# the outer loop against another driver instance; the single
# driver is inherently single-threaded in its claim path.
# Earlier iters shipped a flock/mkdir queue-file lock as
# "defense-in-depth for a future sibling script" but the design
# was wrong for that case too (list_unclaimed reads line numbers
# outside the lock, rewrite_line writes them inside — a sibling
# inserter could still shift lines between read and write).
# Shipping documented-dead, provably-broken code violates
# AGENTS.md #6. If a sibling script ever needs to mutate
# queue.md, add a proper single-lock-spans-read-modify-write
# then; do not resurrect a partial one.

say() { printf '[factory %s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >&2; }

# Queue mechanics: validate_queue, reclaim_stranded, list_unclaimed,
# rewrite_line, claim_tasks, iso_to_epoch. Extracted into a library
# so this file stays focused on the outer loop + worker lifecycle.
# `say` is defined above and used by the sourced code.
# shellcheck source=./lib/queue.sh
. "$FACTORY_ROOT/lib/queue.sh"

# Prepare a git worktree for a single worker. Aggressively cleans
# up any stale branch/worktree with the same name — a prior tick
# that crashed after checkout but before release_worktree would
# otherwise wedge every future attempt at the same task_id (git
# refuses `worktree add -b <existing-branch>`).
prepare_worktree() {
  local task_id=$1
  local worktree=$2
  local branch="factory/${task_id}"
  # Remove any stale worktree at the target path OR bound to the
  # target branch. Both `remove` and `prune` are idempotent when
  # the target does not exist.
  ( cd "$REPO_ROOT" && git worktree remove --force "$worktree" 2>/dev/null || true )
  ( cd "$REPO_ROOT" && git worktree prune 2>/dev/null || true )
  rm -rf "$worktree"
  ( cd "$REPO_ROOT" && git branch -D "$branch" 2>/dev/null || true )
  ( cd "$REPO_ROOT" && git fetch origin main --quiet )
  ( cd "$REPO_ROOT" && git worktree add -b "$branch" "$worktree" origin/main --quiet )
}

# Cleanup a worktree after the worker finishes.
release_worktree() {
  local task_id=$1
  local worktree=$2
  ( cd "$REPO_ROOT" && git worktree remove --force "$worktree" 2>/dev/null || true )
  ( cd "$REPO_ROOT" && git branch -D "factory/${task_id}" 2>/dev/null || true )
  rm -rf "$worktree"
}

say "starting: max_workers=$FACTORY_MAX_WORKERS iteration_cap=$FACTORY_ITERATION_CAP node=$FACTORY_NODE"
validate_queue
reclaim_stranded "$STRAND_MAX_AGE_SECONDS"
tick=0
while [ "$tick" -lt "$FACTORY_ITERATION_CAP" ]; do
  tick=$((tick+1))
  say "tick $tick"

  claims=$(claim_tasks "$FACTORY_MAX_WORKERS" "$tick")
  if [ -z "$claims" ]; then
    say "tick $tick: no unclaimed tasks — sleeping 60s"
    sleep 60
    continue
  fi

  # Fork one worker per claim in the background.
  #
  # CRITICAL: this loop runs in the OUTER shell via process
  # substitution `< <(printf …)`, NOT via `printf … | while`. With
  # the pipe form the `while` runs in a subshell, `&` backgrounds
  # a GRANDCHILD of the outer script, `$!` inside the subshell
  # names that grandchild, and the outer shell's later
  # `wait "$pid"` errors "not a child of this shell" — which was
  # being swallowed by `|| true`. That silent race let every tick
  # classify every worker as "no FACTORY_RESULT line" and yanked
  # the worktree (via `release_worktree --force`) out from under a
  # still-running worker. Process substitution keeps `while` in
  # the outer shell so `$!` refers to real children.
  workers_file="${FACTORY_LOG_DIR}/factory-tick-${tick}-workers.tsv"
  : > "$workers_file"
  while read -r line_num task_id worker_id worktree; do
    [ -n "$task_id" ] || continue
    say "tick $tick: preparing worktree for $task_id"
    if ! prepare_worktree "$task_id" "$worktree"; then
      rewrite_line "$line_num" "- [!] [FAILED at $(date -u '+%Y-%m-%dT%H:%M:%SZ'): worktree_prepare_failed] ${task_id}: (worktree setup failed)"
      continue
    fi
    result_file="${FACTORY_LOG_DIR}/factory-result-${worker_id}.txt"
    rm -f "$result_file"
    ( sh "$FACTORY_ROOT/spawn-worker.sh" "$task_id" "$line_num" "$worker_id" "$worktree" > "$result_file" 2>&1 ) &
    pid=$!
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$pid" "$line_num" "$task_id" "$worker_id" "$worktree" "$result_file" \
      >> "$workers_file"
    say "tick $tick: spawned pid=$pid for $task_id"
  done < <(printf '%s\n' "$claims")

  if [ ! -s "$workers_file" ]; then
    say "tick $tick: no workers spawned this tick — moving on"
    continue
  fi

  while read -r pid line_num task_id worker_id worktree result_file; do
    [ -n "$pid" ] || continue
    say "tick $tick: waiting on pid=$pid task=$task_id"
    # `wait` errors on unknown PID are a diagnostic worth
    # surfacing — they mean the process-substitution invariant in
    # the spawn loop above broke and we're back to the
    # grandchild-race pattern. Do NOT swallow with `|| true`.
    wait "$pid" || say "tick $tick: WARNING wait failed for pid=$pid task=$task_id"
    result=$(cat "$result_file" 2>/dev/null | grep '^FACTORY_RESULT:' | tail -1)
    now_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    if printf '%s' "$result" | grep -q 'STATUS=opened'; then
      # Self-modification rail — enforced by the driver against
      # the actual diff, not against the brief text. A rogue agent
      # (or a brief the agent misread) could edit ops/factory/**
      # or ops/preswarm-check/** (both are gates the agent is
      # being judged by); a diff check here catches it before we
      # accept the PR as "done".
      #
      # This is fail-CLOSED against BOTH the "malicious diff" and
      # the "check itself couldn't run" cases:
      #   - missing worktree            → refuse
      #   - `git diff` nonzero exit     → refuse
      #   - malformed / missing PR num  → refuse
      # A stranger reading `README.md §Self-modification rail`
      # will find that promise and this code together. If they
      # ever disagree, `refuse` is the safer default; the human
      # triaging a `- [!]` can inspect the PR and re-open the
      # queue line by hand.
      pr_num=$(printf '%s' "$result" | sed -n 's/.*PR=\([0-9][0-9]*\).*/\1/p')
      refuse_reason=""
      if [ -z "$pr_num" ]; then
        refuse_reason="STATUS=opened but PR number missing/malformed"
      elif [ ! -d "$worktree" ]; then
        refuse_reason="worktree disappeared before diff check ($worktree)"
      else
        # `set -e` at the top of this script would exit the whole
        # driver on any command substitution that returns non-zero
        # (`diff_out=$(cmd)` with cmd failing exits under set -e in
        # modern bash). An `if` guard around the substitution is the
        # only shape that both captures the exit code AND survives
        # set -e — bash EXPLICITLY does not trigger set -e for
        # commands in a conditional context. Do NOT rewrite this as
        # `diff_out=$(...); diff_rc=$?` — that pattern was iter-4's
        # H blocker.
        if diff_out=$(cd "$worktree" && git diff --name-only origin/main..HEAD 2>&1); then
          # Refused path set — ALL judges the factory uses to
          # evaluate itself. Editing any of them from inside a
          # factory-authored PR violates RFC-0001 decision #6.
          #   - ops/factory/**            — this driver + briefs
          #   - ops/preswarm-check/**     — local pre-swarm runner
          #   - workflows/preswarm-check.yaml — pre-swarm workflow
          # brief-template.md rule #2 names each of these; the
          # DRIVER enforces the diff against the same list so the
          # brief and code cannot drift silently.
          forbidden=$(printf '%s\n' "$diff_out" | grep -E '^ops/factory/|^ops/preswarm-check/|^workflows/preswarm-check\.yaml$' || true)
          if [ -n "$forbidden" ]; then
            refuse_reason="touched protected gate paths — $(printf '%s' "$forbidden" | tr '\n' ' ')"
          fi
        else
          refuse_reason="git diff failed in $worktree — output: $(printf '%s' "$diff_out" | head -c 200)"
        fi
      fi
      if [ -n "$refuse_reason" ]; then
        rewrite_line "$line_num" "- [!] [FAILED at ${now_utc}: ${refuse_reason}] ${task_id}: (PR #${pr_num:-?} opened; driver refused)"
        say "tick $tick: task=$task_id REFUSED — $refuse_reason"
      else
        original=$(awk -v ln="$line_num" 'NR==ln{print; exit}' "$QUEUE_FILE")
        rest=$(printf '%s' "$original" | sed 's/^- \[~\][^]]*\] //')
        rewrite_line "$line_num" "- [x] [DONE via #${pr_num}] ${rest}"
        say "tick $tick: task=$task_id done via #$pr_num"
      fi
    else
      reason=$(printf '%s' "$result" | sed -n 's/.*REASON="\(.*\)".*/\1/p')
      [ -n "$reason" ] || reason="no FACTORY_RESULT line"
      original=$(awk -v ln="$line_num" 'NR==ln{print; exit}' "$QUEUE_FILE")
      rest=$(printf '%s' "$original" | sed 's/^- \[~\][^]]*\] //')
      rewrite_line "$line_num" "- [!] [FAILED at ${now_utc}: ${reason}] ${rest}"
      say "tick $tick: task=$task_id FAILED: $reason"
    fi
    release_worktree "$task_id" "$worktree"
  done < "$workers_file"

  rm -f "$workers_file"
done

say "iteration cap ($FACTORY_ITERATION_CAP) reached — exiting"
