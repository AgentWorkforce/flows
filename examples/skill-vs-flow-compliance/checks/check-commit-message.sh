#!/bin/sh
# Rule 4 (conventional commits) as a deterministic check: every commit made
# since BASE_REF must match `type(scope): subject`. Checks every commit in
# the range, not just HEAD, so an agent that makes several commits can't
# pass by cleaning up only the last one.
set -eu
REPO="$1"
BASE_REF="${2:-baseline}"
PATTERN='^(feat|fix|chore|refactor|test|docs)(\([a-z0-9-]+\))?: .+'

cd "$REPO"

subjects=$(git log --format=%s "$BASE_REF"..HEAD)
if [ -z "$subjects" ]; then
  echo "FAIL no commits since $BASE_REF"
  exit 1
fi

bad=0
while IFS= read -r subject; do
  if ! printf '%s' "$subject" | grep -Eq "$PATTERN"; then
    echo "FAIL commit subject does not match 'type(scope): subject': $subject"
    bad=1
  fi
done <<EOF
$subjects
EOF

if [ "$bad" -eq 1 ]; then
  exit 1
fi

echo "PASS every commit since $BASE_REF matches conventional-commit format"
