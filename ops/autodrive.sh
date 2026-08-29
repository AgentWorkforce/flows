#!/bin/sh
# Keep the drive loop fed and delivering, unattended.
#
# This is a shell loop, not an agent, and that is the whole point. Three
# agent-based drivers were tried on 2026-08-29 and all three died silently:
# a cloud-scheduled sweeper (a sandbox cannot authenticate the agent-relay
# CLI), scheduled drive runs (a scheduled run gets no repo), and a chain of
# fleet-spawned autopilots (a spawned agent runs its task once and exits, and
# the succession chain broke after a few generations without saying so).
#
# The mechanical parts of driving need no judgement: is anything running, has
# anything finished, deliver it, launch the next. A loop does that for as long
# as the machine is awake, with no TTL and nothing to keep alive.
#
# What it deliberately does NOT do:
#   - merge anything (a human merges; that rail stays)
#   - decide whether a diff is good (delivery guards refuse forbidden paths;
#     everything else lands as a PR for review)
#   - relaunch a run it just cancelled without recording why
#
# Usage:  nohup sh ops/autodrive.sh > /tmp/autodrive.log 2>&1 &
# Stop:   touch /tmp/autodrive.stop
set -u

REPO="${AUTODRIVE_REPO:-/tmp/flows-ops}"
DELIVER_DIR="${AUTODRIVE_DELIVER_DIR:-/tmp/deliver-test}"
INTERVAL="${AUTODRIVE_INTERVAL:-300}"
MAX_LIVE="${AUTODRIVE_MAX_LIVE:-1}"
STOP_FILE="${AUTODRIVE_STOP:-/tmp/autodrive.stop}"
STATE="${AUTODRIVE_STATE:-/tmp/autodrive-seen.txt}"

touch "$STATE"
say() { echo "[$(date -u +%H:%M:%S)] $*"; }

say "autodrive starting (interval ${INTERVAL}s, max ${MAX_LIVE} live run, stop: $STOP_FILE)"

while [ ! -f "$STOP_FILE" ]; do
  cd "$REPO" 2>/dev/null || { say "FATAL: $REPO missing"; exit 1; }
  git fetch --quiet origin 2>/dev/null
  git reset --quiet --hard origin/main 2>/dev/null
  base=$(git rev-parse --short origin/main)

  # What is live, and what finished since last pass?
  live=$(agent-relay cloud schedules >/dev/null 2>&1; echo "")
  running=0
  for rid in $(cat /tmp/autodrive-live.txt 2>/dev/null); do
    status=$(agent-relay cloud status "$rid" 2>/dev/null | sed -n 's/^Status:[[:space:]]*//p' | head -1)
    case "$status" in
      running|pending)
        running=$((running + 1))
        echo "$rid" >> /tmp/autodrive-live.new
        ;;
      completed|failed)
        if ! grep -q "^$rid$" "$STATE" 2>/dev/null; then
          say "run ${rid%%-*} finished ($status) — delivering"
          rbase=$(grep "^$rid " /tmp/autodrive-bases.txt 2>/dev/null | awk '{print $2}')
          ( cd "$DELIVER_DIR" 2>/dev/null \
            && git fetch --quiet origin \
            && git reset --quiet --hard origin/main \
            && git clean -qfd \
            && DELIVER_BASE="${rbase:-origin/main}" sh ops/deliver-run.sh "$rid" "$DELIVER_DIR" 2>&1 \
            | grep -E "DELIVER_PR_OPENED|DELIVER_FAIL|DELIVER_SKIPPED" | head -3 ) || true
          echo "$rid" >> "$STATE"
        fi
        ;;
      *) say "run ${rid%%-*} status unknown ('$status') — leaving it alone" ;;
    esac
  done
  mv -f /tmp/autodrive-live.new /tmp/autodrive-live.txt 2>/dev/null || : > /tmp/autodrive-live.txt

  if [ "$running" -lt "$MAX_LIVE" ]; then
    say "launching (base $base)"
    out=$(sh ops/launch-gate.sh 3 "Continue the highest-value next step. Read ops/STATE.md for gate truth and open PRs, and ops/BACKLOG.md for known defects, then pick ONE small thing and do it. Prefer: closing a defect the backlog already names with evidence; extending gate 3's Garden (sdk/src/backlog-picker.ts proposes work, sdk/src/work-package-consumer.ts judges it — the loop between them is thin); or hardening something that has failed before. Definition of done: code plus tests, 'cd sdk && npm test' green, and EVERY new test confirmed to FAIL against current code with its literal output in your summary. As your LAST action run 'git status --porcelain' and paste it. Do NOT touch kernel/relayflowd/src/server.rs or sdk/src/demo-hn-monitor.ts. ONE cycle, ten minutes — small and true beats large and aspirational." 2>&1)
    rid=$(echo "$out" | sed -n 's/^Run created: //p' | head -1)
    if [ -n "$rid" ]; then
      say "launched ${rid%%-*}"
      echo "$rid" >> /tmp/autodrive-live.txt
      echo "$rid $base" >> /tmp/autodrive-bases.txt
    else
      say "LAUNCH FAILED: $(echo "$out" | tail -2 | tr '\n' ' ' | cut -c1-160)"
    fi
  else
    say "$running run(s) live — not launching"
  fi

  sleep "$INTERVAL"
done

say "stop file present — autodrive exiting cleanly"
