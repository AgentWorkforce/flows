#!/bin/sh
# Check all tracked files, including lockfiles; untracked scratch is irrelevant.
set -eu
markers=$(mktemp)
trap 'rm -f "$markers"' EXIT HUP INT TERM
status=0
git grep -n -e '^<<<<<<< ' -e '^>>>>>>> ' -- >"$markers" || status=$?
case "$status" in
  0)
    echo "RESTACK_VERIFY no-conflict-markers: FAILED"
    echo "tracked files still contain conflict markers:"
    cat "$markers"
    exit 1
    ;;
  1) echo "RESTACK_VERIFY no-conflict-markers: PASSED" ;;
  *)
    echo "RESTACK_VERIFY no-conflict-markers: FAILED (git grep exit $status)" >&2
    exit 1
    ;;
esac
