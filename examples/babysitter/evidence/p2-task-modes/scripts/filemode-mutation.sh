#!/usr/bin/env bash
# Mutation evidence for the lost-executable-bit fix. Run from the repository root,
# at the commit that contains this script: bash examples/babysitter/evidence/p2-task-modes/scripts/filemode-mutation.sh
set -euo pipefail
export TMPDIR="$HOME/.agent-tmp"
cd "$(dirname "$0")/../../.."
git diff --quiet HEAD -- fix.ts || { echo "fix.ts differs from HEAD; commit it first" >&2; exit 1; }
trap 'git restore --source=HEAD -- fix.ts' EXIT
# Commands are printed shell-escaped (printf %q), so a printed line replays as run.
show() { printf '+'; printf ' %q' "$@"; printf '\n'; }
run() { show "$@"; "$@" 2>&1 || true; }
edit() { show "$@"; "$@"; }
run sha256sum fix.ts

echo; echo "### M1: the private git dir compares file modes (no core.fileMode=false)"
edit python3 -c "p='fix.ts';s=open(p).read();o=\"GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'core.hooksPath'\";assert o in s;s=s.replace(o,\"GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath'\",1);open(p,'w').write(s)"
run git diff --stat -- fix.ts
run node --experimental-strip-types --test --test-name-pattern='dropped executable bits' tests/task.test.ts
run git restore --source=HEAD -- fix.ts
run sha256sum fix.ts

echo; echo "### M2: the checkout's config compares file modes (no git config core.fileMode false)"
edit python3 -c "p='fix.ts';s=open(p).read();o=\"  git('config', 'core.fileMode', 'false');\n\";assert o in s;open(p,'w').write(s.replace(o,'',1))"
run git diff --stat -- fix.ts
run node --experimental-strip-types --test --test-name-pattern='dropped executable bits' tests/fixer.test.ts
run git restore --source=HEAD -- fix.ts
run sha256sum fix.ts

echo; echo "### Restored: both tests"
run node --experimental-strip-types --test --test-name-pattern='dropped executable bits' tests/fixer.test.ts tests/task.test.ts
