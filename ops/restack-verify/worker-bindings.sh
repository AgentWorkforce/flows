#!/bin/sh
# Run the repo's own worker-binding gate, if it has one.
#
# Does not reimplement the check. The point of a restack gate is to re-run the
# checks the repo already trusts, because a merge can invalidate them without
# producing a conflict.
set -eu
SCRIPT="scripts/verify-fast-path-bindings.mjs"
CONFIG="packages/web/wrangler.production.toml"
if [ ! -f "$SCRIPT" ] && [ ! -f "$CONFIG" ]; then
  echo "RESTACK_VERIFY worker-bindings: SKIPPED (no $SCRIPT or $CONFIG)"
  exit 0
fi
for required in "$SCRIPT" "$CONFIG"; do
  if [ ! -f "$required" ]; then
    echo "RESTACK_VERIFY worker-bindings: FAILED (missing $required)" >&2
    exit 1
  fi
done
if node "$SCRIPT" --wrangler-config "$CONFIG"; then
  echo "RESTACK_VERIFY worker-bindings: PASSED"
else
  echo "RESTACK_VERIFY worker-bindings: FAILED"
  exit 1
fi
