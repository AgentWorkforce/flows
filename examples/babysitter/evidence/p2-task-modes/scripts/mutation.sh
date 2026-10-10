#!/usr/bin/env bash
# Each command is echoed with `+` before it runs; all output is verbatim.
set -euo pipefail
export TMPDIR="$HOME/.agent-tmp"
cd "$(dirname "$0")/../../.."
saved="$(mktemp -d)"
# Whatever happens, fix.ts ends as it started: the trap restores it.
trap 'cp "$saved/fix.ts" fix.ts 2>/dev/null; rm -rf "$saved"' EXIT
# Commands are printed shell-escaped (printf %q), so a printed line replays as run.
show() { printf '+'; printf ' %q' "$@"; printf '\n'; }
run() { show "$@"; "$@" 2>&1 || true; }
# A mutation edit that does not apply aborts the script (set -e).
edit() { show "$@"; "$@"; }
cp fix.ts "$saved/fix.ts"
run sha256sum fix.ts

echo; echo "### M1: copy only the index, not the split index's shared files"
edit python3 -c "p='fix.ts';s=open(p).read();o=\"if (name !== 'index' && !name.startsWith('sharedindex.')) continue;\";assert o in s;open(p,'w').write(s.replace(o,\"if (name !== 'index') continue;\"))"
run git diff --stat -- fix.ts
run node --experimental-strip-types --test --test-name-pattern='split' tests/task.test.ts
run cp "$saved/fix.ts" fix.ts
run sha256sum fix.ts

echo; echo "### M2: set up the private git dir before the try (as at 68c6eec1)"
edit python3 -c "
p='fix.ts';s=open(p).read()
a='''  try {
  execFileSync('git', ['init', '-q', scratch]'''
b='''  execFileSync('git', ['init', '-q', scratch]'''
c='''  }
  const buffer ='''
d='''  }
  try {
  const buffer ='''
assert a in s and c in s
open(p,'w').write(s.replace(a,b,1).replace(c,d,1))"
run git diff -- fix.ts
run node --experimental-strip-types --test --test-name-pattern='scratch behind' tests/task.test.ts
run cp "$saved/fix.ts" fix.ts
run sha256sum fix.ts

# The PR's base (the flows#644 merge, 620dc0da): an immutable commit whose
# fix.ts still rewrites the checkout's .git/config.
BASE=620dc0daa48bf4fccc1c1518e52d3edcc2433746
echo; echo "### M3: fix.ts from the PR's base $BASE (rewrites the checkout's .git/config)"
show git show "$BASE:examples/babysitter/fix.ts"
git show "$BASE:examples/babysitter/fix.ts" > "$saved/base.ts"
run cp "$saved/base.ts" fix.ts
run node --experimental-strip-types --test --test-name-pattern='unwritable' tests/task.test.ts
run cp "$saved/fix.ts" fix.ts
run sha256sum fix.ts
run git status --short -- .

echo; echo "### M4: copy any entry named like an index, not only regular files"
edit python3 -c "p='fix.ts';s=open(p).read();o='    if (!stat.isFile()) continue;\n';assert o in s;open(p,'w').write(s.replace(o,''))"
run git diff --stat -- fix.ts
run timeout 60 node --experimental-strip-types --test --test-timeout=20000 --test-name-pattern='FIFO' tests/task.test.ts
run cp "$saved/fix.ts" fix.ts
run sha256sum fix.ts

echo; echo "### M5: a missing or non-regular active index is skipped, not refused"
edit python3 -c "p='fix.ts';s=open(p).read();i=s.index('  if (!lstatSync(');j=s.index('\n', s.index('return process.stdout.write', i))+1;open(p,'w').write(s[:i]+s[j:])"
run git diff --stat -- fix.ts
run node --experimental-strip-types --test --test-name-pattern='symlink, or deleted' tests/task.test.ts
run cp "$saved/fix.ts" fix.ts
run sha256sum fix.ts

echo; echo "### Restored: the full suite"
run node --experimental-strip-types --test tests/task.test.ts
