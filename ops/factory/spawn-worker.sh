#!/bin/sh
# Spawn ONE agent-relay Claude Code agent for ONE claimed task.
# Called by ops/factory/driver.sh in a background subshell per
# worker. Not intended to be invoked directly.
#
# Arguments (all required, positional):
#   $1 = TASK_ID          (e.g. hn-monitor-real-cli)
#   $2 = TASK_LINE_NUM    (1-based line number in queue.md)
#   $3 = WORKER_ID        (unique per driver tick, e.g. factory-1-abc123)
#   $4 = WORKTREE_PATH    (absolute path to the scratch worktree)
#
# Env inputs:
#   FACTORY_NODE            — agent-relay node name (default sf-mini)
#   FACTORY_WORKSPACE_KEY   — passed as `--wk` when set
#   FACTORY_LOG_DIR         — where per-worker logs land (default /tmp)
#
# Output on stdout: one line
#   FACTORY_RESULT: PR=<n> STATUS=opened
#   FACTORY_RESULT: STATUS=failed REASON="<reason>"

set -eu

TASK_ID=${1:?"missing TASK_ID"}
TASK_LINE_NUM=${2:?"missing TASK_LINE_NUM"}
WORKER_ID=${3:?"missing WORKER_ID"}
WORKTREE_PATH=${4:?"missing WORKTREE_PATH"}

FACTORY_NODE=${FACTORY_NODE:-sf-mini}
FACTORY_LOG_DIR=${FACTORY_LOG_DIR:-/tmp}
FACTORY_ROOT=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$FACTORY_ROOT/../.." && pwd)

BRIEF_FILE="$FACTORY_ROOT/briefs/${TASK_ID}.md"
if [ ! -f "$BRIEF_FILE" ]; then
  echo "FACTORY_RESULT: STATUS=failed REASON=\"missing brief $BRIEF_FILE\""
  exit 0
fi

# Self-modification enforcement is DIFF-based, in the DRIVER,
# post-worker (see ops/factory/driver.sh — after STATUS=opened,
# before rewriting the queue line to `- [x]`, the driver checks
# `git diff --name-only origin/main..HEAD` in the worktree and
# refuses to record success if any file under `ops/factory/**`
# appears). A spawn-time grep of the brief TEXT would refuse
# every brief — every brief says "do not touch ops/factory/" in
# its rules block, so the string is present by construction. The
# diff is the source of truth; the brief text and pre-swarm-check
# M lens are advisory layers above it.

BRANCH="factory/${TASK_ID}"
LOG_FILE="${FACTORY_LOG_DIR}/factory-${WORKER_ID}.log"

# Substitute placeholders in the template.
#
# `awk -v var=value` runs the value through C-string escape
# processing before the awk program sees it — any `\n`, `\t`, or
# literal backslash in a brief becomes something else, silently.
# Briefs will contain shell snippets, regex, and paths, so we must
# NOT hand the body to awk that way. Instead we materialize summary
# and body as files and use `getline` from inside awk, which
# consumes bytes verbatim. `sed`'s replacement doesn't do C-escape
# processing on our simple `|`-delimited placeholders, so TASK_ID
# and WORKTREE_PATH stay as-is (both are constrained to
# kebab-case / a POSIX temp path — no `|`, `&`, or `\` present by
# construction).
TASK_SUMMARY=$(head -1 "$BRIEF_FILE" | sed 's/^# *//')
_SUMMARY_TMP=$(mktemp "${FACTORY_LOG_DIR}/factory-summary.XXXXXX")
_BODY_TMP=$(mktemp "${FACTORY_LOG_DIR}/factory-body.XXXXXX")
_TMPL_TMP=$(mktemp "${FACTORY_LOG_DIR}/factory-tmpl.XXXXXX")
trap 'rm -f "$_SUMMARY_TMP" "$_BODY_TMP" "$_TMPL_TMP"' EXIT
printf '%s\n' "$TASK_SUMMARY" > "$_SUMMARY_TMP"
sed -n '2,$p' "$BRIEF_FILE" > "$_BODY_TMP"
sed -e "s|<TASK_ID>|${TASK_ID}|g" \
    -e "s|<WORKTREE_PATH>|${WORKTREE_PATH}|g" \
    "$FACTORY_ROOT/brief-template.md" > "$_TMPL_TMP"
PROMPT=$(awk -v sfile="$_SUMMARY_TMP" -v bfile="$_BODY_TMP" '
    /<TASK_SUMMARY>/     { while ((getline line < sfile) > 0) print line; close(sfile); next }
    /<TASK_BRIEF_BODY>/  { while ((getline line < bfile) > 0) print line; close(bfile); next }
    { print }
' "$_TMPL_TMP")

echo "spawn-worker[$WORKER_ID]: task=$TASK_ID branch=$BRANCH worktree=$WORKTREE_PATH" >&2
echo "spawn-worker[$WORKER_ID]: log=$LOG_FILE" >&2

# The agent runs in the worktree; agent-relay's `fleet spawn` takes
# the prompt via `--task` and streams the agent's transcript back on
# stdout. We pipe the whole thing through tee so we can grep for the
# FACTORY_RESULT line without losing the transcript to disk.
# Build the spawn arg list with `set --` so `--wk <key>` stays as
# TWO tokens even if $FACTORY_WORKSPACE_KEY ever contains a space
# (unquoted `$WK_ARG` word-splits and would silently truncate the
# key). Positional params make this explicit without eval.
set -- --node "$FACTORY_NODE" --name "$WORKER_ID"
if [ -n "${FACTORY_WORKSPACE_KEY:-}" ]; then
  set -- "$@" --wk "$FACTORY_WORKSPACE_KEY"
fi
set -- "$@" --cwd "$WORKTREE_PATH" --task "$PROMPT"

set +e
agent-relay fleet spawn claude "$@" > "$LOG_FILE" 2>&1
SPAWN_RC=$?
set -e

if [ "$SPAWN_RC" -ne 0 ]; then
  echo "FACTORY_RESULT: STATUS=failed REASON=\"agent-relay spawn exited $SPAWN_RC — see $LOG_FILE\""
  exit 0
fi

# The agent's LAST `FACTORY_RESULT:` line is the authoritative
# outcome. Anything else it printed is transcript.
RESULT_LINE=$(grep '^FACTORY_RESULT:' "$LOG_FILE" | tail -1)
if [ -z "$RESULT_LINE" ]; then
  echo "FACTORY_RESULT: STATUS=failed REASON=\"agent produced no FACTORY_RESULT line — see $LOG_FILE\""
  exit 0
fi

printf '%s\n' "$RESULT_LINE"
