#!/bin/sh
# Mutation check for the PR #501 recovery guards. Replayable: run it from the
# repository root of a clean checkout of the commit it prints first. Every
# command is printed exactly as it runs (`$ ...`), followed by its own exit
# code and the outcome it was expected to have; each mutation is a committed
# patch under mutations/, applied with git apply and undone with git checkout,
# and the tree is proven identical to the commit (git diff --exit-code) before
# every run. The script exits nonzero if any expectation is missed: a GREEN run
# that fails, a mutation its suite does not catch, or a tree left dirty.
set -u
dir=kernel/evidence/501/mutations
missed=0
# run EXPECT COMMAND: EXPECT is `pass` (exit 0) or `fail` (nonzero).
run() {
  printf '$ %s\n' "$2"
  sh -c "$2" 2>&1
  code=$?
  if { [ "$1" = pass ] && [ "$code" -eq 0 ]; } || { [ "$1" = fail ] && [ "$code" -ne 0 ]; }; then
    verdict=ok
  else
    verdict=MISSED
    missed=$((missed + 1))
  fi
  printf 'exit_code=%s expected=%s %s\n\n' "$code" "$1" "$verdict"
}
# Test output is filtered to the verdict lines; exit_code is cargo's own.
cargo_test() {
  run "$1" "cd kernel && out=\$(cargo test $2 2>&1); code=\$?; printf '%s\\n' \"\$out\" | grep -E '^test |^test result'; exit \$code"
}
CORE='-p relayflowd-core --lib -- machine::recovery_tests machine::tests::refused_dispatch'
DRIVER='-p relayflowd --test parallel_driver'

printf '### 0. Revision under test\n\n'
run pass 'git rev-parse HEAD'
run pass 'git diff --exit-code --stat -- kernel'

printf '### 1. GREEN at the commit\n\n'
cargo_test pass "$CORE"
cargo_test pass "$DRIVER"

# mutation, expected core outcome, expected driver outcome
for case in a-manual-park-off:fail:pass b-torn-park-repair-off:fail:pass \
  c-refused-dispatch-retry-off:fail:fail d-refusal-not-charged:fail:pass; do
  mutation=${case%%:*}
  rest=${case#*:}
  printf '### Mutation %s\n\n' "$mutation"
  run pass "git apply $dir/$mutation.patch"
  run pass 'git diff -U0 -- kernel/relayflowd-core/src'
  cargo_test "${rest%%:*}" "$CORE"
  cargo_test "${rest#*:}" "$DRIVER"
  run pass 'git checkout -- kernel/relayflowd-core/src'
  run pass 'git diff --exit-code --stat -- kernel'
done

printf '### 2. GREEN again after restore\n\n'
cargo_test pass "$CORE"
cargo_test pass "$DRIVER"

printf '### Result: %s expectation(s) missed\n' "$missed"
[ "$missed" -eq 0 ]
