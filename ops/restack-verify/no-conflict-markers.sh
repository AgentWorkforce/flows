#!/bin/sh
# Fail if any TRACKED file still carries a conflict marker.
#
# Deliberately excludes lockfiles: a resolved lockfile legitimately contains
# long hash strings, and matching on "<<<<<<<" at line start avoids those
# anyway. Uses git grep so untracked scratch files cannot fail the gate.
set -eu
if git grep -n -e '^<<<<<<< ' -e '^>>>>>>> ' -- ':!*.lock' ':!*-lock.json' >/tmp/rv-markers.txt 2>/dev/null; then
  echo "RESTACK_VERIFY no-conflict-markers: FAILED"
  echo "tracked files still contain conflict markers:"
  cat /tmp/rv-markers.txt
  exit 1
fi
echo "RESTACK_VERIFY no-conflict-markers: PASSED"
