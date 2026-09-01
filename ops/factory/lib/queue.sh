#!/bin/bash
# ops/factory/lib/queue.sh — queue mechanics for the factory driver.
#
# Sourced by ops/factory/driver.sh. Callers must have set QUEUE_FILE
# to an absolute path before sourcing. Every function here is a pure
# read or a tmp-then-mv over QUEUE_FILE — safe under the single-
# DRIVER_LOCK invariant driver.sh maintains.
#
# Extracted from driver.sh (iter 8) to address S-lens "monolith"
# concern. driver.sh now composes; this file owns:
#   - queue-format validation (validate_queue)
#   - stranded-claim reclamation (reclaim_stranded, iso_to_epoch)
#   - line-level read+rewrite primitives (list_unclaimed, rewrite_line)
#   - claim orchestration (claim_tasks)
#
# NOT a shared library across packages — scoped to ops/factory/.

# --- helpers ---------------------------------------------------------

# Portable ISO-UTC to epoch. GNU date first, BSD fallback (macOS
# ships `date -j -f`). Returns 0 on parse failure so the caller can
# skip that line safely.
iso_to_epoch() {
  local iso=$1
  local out
  out=$(date -u -d "$iso" '+%s' 2>/dev/null) && { printf '%s\n' "$out"; return; }
  out=$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$iso" '+%s' 2>/dev/null) && { printf '%s\n' "$out"; return; }
  printf '0\n'
}

# --- validation ------------------------------------------------------

# Reject queue-line summaries that would break the state-cycle
# machinery. The driver's `sed 's/^- \[~\][^]]*\] //'` stops at the
# first `]`; the awk-based `rewrite_line` (below) uses file-based
# input so backslashes are safe THERE, but the queue file is human-
# authored and other tools may consume it too. Reject:
#   - `]` in the summary (state-cycle sed corruption)
#   - `\` in the summary (defense against tools that DO awk -v it)
#   - whitespace in TASK_ID (the driver uses `read` split on IFS and
#     would silently truncate the id, producing garbage worker names
#     and branch names)
# Exits 4 on any violation.
validate_queue() {
  local bad
  bad=$(awk '
    /^- \[[ ~x!]\]/ {
      idx = index($0, "] ")
      if (idx > 0) {
        rest = substr($0, idx + 2)
        # Skip past the state-meta block [CLAIMED …] / [DONE …] / [FAILED …]
        if ($0 ~ /^- \[[ ~x!]\] \[/) {
          m = index(rest, "] ")
          if (m > 0) rest = substr(rest, m + 2)
        }
        if (rest ~ /\]/)  { print NR ": ] in summary: " $0 ; had_bad=1 }
        if (rest ~ /\\/)  { print NR ": \\ in summary: " $0 ; had_bad=1 }
        # TASK_ID is everything up to the first colon in `rest`.
        colon = index(rest, ":")
        if (colon > 0) {
          id = substr(rest, 1, colon - 1)
          if (id ~ /[ \t]/) { print NR ": whitespace in TASK_ID (\"" id "\"): " $0 ; had_bad=1 }
        }
      }
    }
  ' "$QUEUE_FILE")
  if [ -n "$bad" ]; then
    echo "driver: queue.md has malformed lines — the state cycle would silently corrupt them. Fix:" >&2
    printf '%s\n' "$bad" >&2
    exit 4
  fi
}

# --- reclamation -----------------------------------------------------

# Reclaim `- [~]` lines whose embedded CLAIMED-at timestamp is
# older than $1 seconds. Called once at driver startup — a task
# the previous driver instance died mid-work on gets reset to
# `- [ ] TASK_ID: <original summary>`. `- [~]` line shape:
#   - [~] [CLAIMED by <worker> at <ISO-UTC>] TASK_ID: <summary>
#
# CAVEAT: reclamation ASSUMES stranded = dead. If an operator
# SIGKILLs the driver but agent-relay workers keep running on
# their remote node, the next tick could spawn a duplicate on
# the same task. The operator MUST kill any lingering agent-relay
# workers (or wait for their leases to expire) before restarting
# after a hard driver crash. Ordinary Ctrl-C exits cleanly via
# the trap in driver.sh and does NOT strand claims.
#
# Portable across BSD awk (macOS) and GNU awk — no capture-group
# form; extraction uses shell parameter expansion.
reclaim_stranded() {
  local threshold=$1
  if [ "$threshold" -le 0 ]; then return; fi
  local now_epoch tmp reclaimed line at_pos after_at iso claimed_epoch after_meta
  now_epoch=$(date -u '+%s')
  tmp="${QUEUE_FILE}.tmp"
  reclaimed=0
  : > "$tmp"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "- [~] [CLAIMED by "*)
        at_pos=$(printf '%s\n' "$line" | awk '{print index($0, " at ")}')
        if [ "$at_pos" -gt 0 ]; then
          after_at=${line#* at }
          iso=${after_at%%]*}
          claimed_epoch=$(iso_to_epoch "$iso")
          if [ "$claimed_epoch" -gt 0 ] && [ $((now_epoch - claimed_epoch)) -gt "$threshold" ]; then
            after_meta=${line#*\] }
            after_meta=${after_meta#*\] }
            printf '%s\n' "- [ ] $after_meta" >> "$tmp"
            reclaimed=$((reclaimed + 1))
            continue
          fi
        fi
        printf '%s\n' "$line" >> "$tmp"
        ;;
      *)
        printf '%s\n' "$line" >> "$tmp"
        ;;
    esac
  done < "$QUEUE_FILE"
  if [ "$reclaimed" -gt 0 ]; then
    mv -f "$tmp" "$QUEUE_FILE"
    say "reclaimed $reclaimed stranded [~] task(s) older than ${threshold}s (operator must have killed agent-relay workers before restart, or duplicates will spawn)"
  else
    rm -f "$tmp"
  fi
}

# --- read primitives -------------------------------------------------

# Extract up to $1 task IDs from unclaimed (- [ ]) lines. Returns
# newline-separated `<line_num> <task_id>` pairs on stdout.
# Portable across BSD awk (macOS) and gawk — no capture-group form.
list_unclaimed() {
  local want=$1
  awk -v want="$want" '
    /^- \[ \] / {
      rest = substr($0, 7)         # drop "- [ ] "
      idx = index(rest, ":")
      if (idx > 1) {
        id = substr(rest, 1, idx - 1)
        sub(/[[:space:]]+$/, "", id)
        if (id != "") {
          print NR " " id
          count++
          if (count >= want) exit
        }
      }
    }
  ' "$QUEUE_FILE"
}

# --- write primitives ------------------------------------------------

# Rewrite a queue line. $1 = line number, $2 = replacement text.
#
# CRITICAL: reads the replacement text from a temp file inside awk
# via `getline`, NOT via `awk -v new=…`. `awk -v` applies C-string
# escape processing to its value, so any `\n`, `\t`, or literal
# backslash in the replacement would silently mutate before awk
# saw it — the same trap spawn-worker.sh's brief-body substitution
# guards against. `validate_queue` also rejects `\` in queue
# summaries at claim time, so `$2` should be backslash-free by
# construction, but this pattern is defense-in-depth: if a future
# change loosens validate_queue, this file survives it.
#
# Safe under the single-DRIVER_LOCK invariant; tmp-then-mv is
# atomic on a local FS.
rewrite_line() {
  local line_num=$1
  local new_line=$2
  local repl tmp
  repl=$(mktemp "${FACTORY_LOG_DIR}/factory-rewrite.XXXXXX")
  tmp="${QUEUE_FILE}.tmp"
  printf '%s\n' "$new_line" > "$repl"
  awk -v ln="$line_num" -v rf="$repl" '
    NR==ln { while ((getline line < rf) > 0) print line; close(rf); next }
    { print }
  ' "$QUEUE_FILE" > "$tmp"
  mv -f "$tmp" "$QUEUE_FILE"
  rm -f "$repl"
}

# --- claim orchestration ---------------------------------------------

# Claim + return `<line_num> <task_id> <worker_id> <worktree>` per
# task, tab-separated, newline-separated. Empty output means
# nothing to claim.
claim_tasks() {
  local want=$1
  local tick=$2
  local unclaimed now_utc i worker_id worktree original rest line_num task_id
  unclaimed=$(list_unclaimed "$want")
  if [ -z "$unclaimed" ]; then return; fi
  now_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  i=0
  echo "$unclaimed" | while read -r line_num task_id; do
    [ -n "$line_num" ] || continue
    i=$((i+1))
    worker_id="factory-t${tick}-w${i}-${task_id}"
    worktree="/tmp/factory-worktree-${worker_id}"
    original=$(awk -v ln="$line_num" 'NR==ln{print; exit}' "$QUEUE_FILE")
    rest=$(printf '%s' "$original" | sed "s/^- \\[ \\] //")
    rewrite_line "$line_num" "- [~] [CLAIMED by ${worker_id} at ${now_utc}] ${rest}"
    printf '%s\t%s\t%s\t%s\n' "$line_num" "$task_id" "$worker_id" "$worktree"
  done
}
