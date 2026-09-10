#!/bin/sh
# Rule 3 (no secrets) as a deterministic check: grep added lines for
# common credential shapes. Deliberately conservative patterns (real
# secret-scanners are far more elaborate); this is the "checkable core"
# slice, not a replacement for a dedicated scanner.
set -eu
REPO="$1"
BASE_REF="${2:-baseline}"

cd "$REPO"

diff=$(git diff "$BASE_REF"...HEAD)
added_lines=$(printf '%s\n' "$diff" | sed -n '/^+++ /d; /^+/p')

hit=$(printf '%s\n' "$added_lines" | grep -E \
  -e 'AKIA[0-9A-Z]{16}' \
  -e 'sk-[A-Za-z0-9]{20,}' \
  -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' \
  -e '[Aa]pi[_-]?[Kk]ey[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9/+_-]{16,}["'"'"']' \
  -e '[Ss]ecret[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9/+_-]{16,}["'"'"']' \
  || true)

if [ -n "$hit" ]; then
  echo "FAIL credential-shaped literal(s) in added lines:"
  echo "$hit" | head -n 10
  exit 1
fi

echo "PASS no credential-shaped literals in added lines"
