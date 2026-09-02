#!/usr/bin/env bash
# Run a flows workflow against the canonical cloud workspace, so a human can
# follow it live at agentrelay.com (channels + observer link).
# Usage: scripts/run-workflow.sh workflows/<file>.yaml [relayflows args...]
set -euo pipefail
cd "$(dirname "$0")/.."

# The broker is pinned via `agent-relay workspace rebind default` (stored key),
# but the relayflows runner resolves its own Relaycast credential from
# RELAY_API_KEY and nothing else. Without the export below the pin check passes
# and the runner still auto-creates a throwaway workspace — the run executes,
# but it lands somewhere no human can watch and whose key nobody ever sees.
#
# `workspace key` masks the secret unless asked; --reveal-secrets yields the
# real `rk_live_` material. It is never echoed: it is an administrative
# credential (send, spawn, administer), and the engine rejects it on the
# realtime endpoint anyway.
RELAY_API_KEY="$(agent-relay workspace key --reveal-secrets 2>/dev/null | tr -d '[:space:]' || true)"
if [[ -z "${RELAY_API_KEY}" || "${RELAY_API_KEY}" != rk_live_* ]]; then
  echo "No stored workspace key — run: agent-relay workspace rebind default" >&2
  exit 1
fi
export RELAY_API_KEY

# Mint the read-only follow-along link up front, so a human has it from the
# first step rather than after the run is over. A scoped `ot_live_` token is the
# credential built for this: read-only, expiring, individually revocable. Never
# put the workspace key in a URL — query strings land in browser history,
# referrer headers, and proxy logs.
observer_url="$(agent-relay observer --expires 24h --json 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("url",""))' 2>/dev/null || true)"
if [[ -n "${observer_url}" ]]; then
  echo "Workspace observer: ${observer_url}"
else
  echo "Workspace observer: unavailable — mint one with \`agent-relay observer\`" >&2
fi

exec relayflows run "$@"
