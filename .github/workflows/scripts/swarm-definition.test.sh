#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
validator="$script_dir/swarm-definition.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cat > "$work/trusted.yaml" <<'YAML'
swarm:
  timeoutMs: 3600000
YAML

cat > "$work/candidate.yaml" <<'YAML'
version: '1.0'
swarm:
  timeoutMs: 3600000
errorHandling:
  strategy: retry
  retryDelayMs: 60000
YAML

expect_reject() {
  local label=$1
  shift
  if "$@" >"$work/out" 2>&1; then
    echo "FAIL: $label unexpectedly passed" >&2
    cat "$work/out" >&2
    exit 1
  fi
  echo "ok: $label"
}

"$validator" "$work/candidate.yaml" "$work/trusted.yaml" | grep -q '^CANDIDATE_DEFINITION_OK$'
echo "ok: valid candidate passes"

sed 's/retryDelayMs: 60000/retryDelayMs: 1000/' "$work/candidate.yaml" > "$work/short-delay.yaml"
expect_reject "short retry delay" "$validator" "$work/short-delay.yaml" "$work/trusted.yaml"

sed 's/timeoutMs: 3600000/timeoutMs: 1800000/' "$work/candidate.yaml" > "$work/short-timeout.yaml"
expect_reject "changed timeout" "$validator" "$work/short-timeout.yaml" "$work/trusted.yaml"

printf 'not: [valid\n' > "$work/broken.yaml"
expect_reject "invalid YAML" "$validator" "$work/broken.yaml" "$work/trusted.yaml"

ln -s "$work/candidate.yaml" "$work/candidate-link.yaml"
expect_reject "symbolic-link candidate" "$validator" "$work/candidate-link.yaml" "$work/trusted.yaml"

echo "swarm-definition: all tests passed"
