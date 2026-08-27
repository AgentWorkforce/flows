#!/usr/bin/env bash
# Run a flows workflow with the broker pinned to the canonical cloud workspace,
# so every run is observable at agentrelay.com (channels + observer links).
# Usage: scripts/run-workflow.sh workflows/<file>.yaml [relayflows args...]
set -euo pipefail
cd "$(dirname "$0")/.."
# Broker is pinned via `agent-relay workspace rebind default` (stored key).
# Fail loudly if the pin is missing rather than silently running ephemeral:
agent-relay workspace key >/dev/null 2>&1 || {
  echo "No stored workspace key — run: agent-relay workspace rebind default" >&2; exit 1; }
exec relayflows run "$@"
