#!/usr/bin/env bash
set -euo pipefail
export RELAY_API_KEY="$(agent-relay workspace key --reveal-secrets 2>/dev/null | tr -d '[:space:]')"
export RELAYFLOWD_BIN=/tmp/flows-pr-cleanup/pr499/kernel/target/debug/relayflowd
export RELAYFLOW_RELAY_BROKER_BIN=/home/khaliqgant/Projects/AgentWorkforce/relay/target/release/agent-relay-broker
export FLOW_COMMUNICATION_UNRELATED_SECRET=test-only-sentinel
node packages/sdk/dist/cli.js run /tmp/flows-pr500-review-live/ring-direct.json --local-agent --data-dir /tmp/flows-pr500-review-live/data-final --json
