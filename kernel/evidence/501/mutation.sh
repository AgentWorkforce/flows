#!/bin/sh
# Mutation check for the PR #501 recovery guards. Replayable: run it from the
# repository root of a clean checkout of the commit it prints first. Every
# command is printed exactly as it runs (`$ ...`), followed by its exit code;
# each mutation is a committed patch under mutations/, applied with git apply
# and undone with git checkout, and the tree is proven identical to the
# commit (git diff --exit-code) before every run.
set -u
dir=kernel/evidence/501/mutations
run() {
  printf '$ %s\n' "$1"
  sh -c "$1" 2>&1
  printf 'exit_code=%s\n\n' "$?"
}
# Test output is filtered to the verdict lines; exit_code is cargo's own.
cargo_test() {
  run "cd kernel && out=\$(cargo test $1 2>&1); code=\$?; printf '%s\\n' \"\$out\" | grep -E '^test |^test result'; exit \$code"
}
tests() {
  cargo_test '-p relayflowd-core --lib -- machine::recovery_tests machine::tests::refused_dispatch'
  cargo_test '-p relayflowd --test parallel_driver'
}

printf '### 0. Revision under test\n\n'
run 'git rev-parse HEAD'
run 'git diff --exit-code --stat -- kernel'

printf '### 1. GREEN at the commit\n\n'
tests

for mutation in a-manual-park-off b-torn-park-repair-off c-refused-dispatch-retry-off; do
  printf '### Mutation %s\n\n' "$mutation"
  run "git apply $dir/$mutation.patch"
  run 'git diff -U0 -- kernel/relayflowd-core/src'
  tests
  run 'git checkout -- kernel/relayflowd-core/src'
  run 'git diff --exit-code --stat -- kernel'
done

printf '### 2. GREEN again after restore\n\n'
tests
