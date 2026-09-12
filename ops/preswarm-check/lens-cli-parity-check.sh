#!/bin/sh
# lens-cli-parity-check: verify the runner (ops/preswarm-check/lens-runner.sh)
# and the cloud swarm spec (workflows/review-swarm.yaml) agree on which CLI
# each lens uses. flows#255 traced the "structure lens MISSING on every PR"
# failure to `opencode` being unavailable on both runners; keeping the two
# files in sync stops the same shape of drift from resurfacing.
#
# Also refuses if any lens is mapped to a CLI whose binary is not on PATH in
# this environment — that would reproduce the exact failure this check
# exists to prevent (the gate exits NO_VERDICT because the CLI call fails
# silently). PRESWARM_ALLOW_MISSING_CLI=1 lets a shakedown or a machine
# without every CLI installed proceed anyway.
#
# Usage: sh ops/preswarm-check/lens-cli-parity-check.sh
# Exit 0 on match + presence, 1 on divergence or missing CLI, 2 on setup error.
set -e

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
RUNNER="$REPO_ROOT/ops/preswarm-check/lens-runner.sh"
SWARM_YAML="$REPO_ROOT/workflows/review-swarm.yaml"

for f in "$RUNNER" "$SWARM_YAML"; do
  if [ ! -s "$f" ]; then
    echo "lens-cli-parity-check: $f missing or empty" >&2
    exit 2
  fi
done

# Extract `<lens>) CLI=<cli> ;;` mapping from the runner. Anchored so a comment
# mentioning `structure) CLI=opencode` cannot pollute the match.
runner_cli() {
  lens=$1
  awk -v lens="$lens" '
    $0 ~ ("^ *"lens"\\)[[:space:]]+CLI=") {
      # Strip everything up to CLI= and the trailing " ;;" comment/whitespace.
      sub(/^.*CLI=/, "")
      sub(/[[:space:]]*;;.*$/, "")
      print
      exit
    }
  ' "$RUNNER"
}

# Extract `cli: <cli>` for `- name: <lens>` in the swarm yaml agents block.
swarm_cli() {
  lens=$1
  awk -v marker="- name: $lens" '
    index($0, marker) { found=1; next }
    found && /^  - name:/ { exit }
    found && /^    cli:[[:space:]]/ {
      sub(/^    cli:[[:space:]]*/, "")
      print
      exit
    }
  ' "$SWARM_YAML"
}

fail=0
for lens in maintainability history structure; do
  r=$(runner_cli "$lens")
  s=$(swarm_cli "$lens")
  if [ -z "$r" ] || [ -z "$s" ]; then
    echo "lens-cli-parity-check: FAIL — could not resolve CLI for lens '$lens' (runner='$r' swarm='$s')" >&2
    fail=1
    continue
  fi
  if [ "$r" != "$s" ]; then
    echo "lens-cli-parity-check: FAIL — lens '$lens' CLI divergence: runner='$r' swarm='$s'" >&2
    fail=1
    continue
  fi
  if [ "${PRESWARM_ALLOW_MISSING_CLI:-0}" != "1" ] && ! command -v "$r" >/dev/null 2>&1; then
    echo "lens-cli-parity-check: FAIL — lens '$lens' uses CLI '$r' but the binary is not on PATH (set PRESWARM_ALLOW_MISSING_CLI=1 to bypass)" >&2
    fail=1
  fi
done

if [ "$fail" -eq 1 ]; then
  exit 1
fi

echo "lens-cli-parity-check: PASS — three lenses, runner and swarm agree, every CLI present."
