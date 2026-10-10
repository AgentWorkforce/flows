#!/usr/bin/env bash
# Mutation verification: revert one change, run the test that pins it (red),
# restore the file byte-for-byte (cmp), run again (green).
set -u
cd "$(dirname "$0")/../.."
run() { node --experimental-strip-types --test --test-name-pattern="$1" tests/task.test.ts 2>&1 | grep -E '^(✔|✖) |^ℹ (pass|fail)'; }
mutate() { # file, sed expression, test pattern, label
  local file=$1 expr=$2 pattern=$3 label=$4
  cp "$file" "$file.orig"
  local before; before=$(sha256sum < "$file")
  sed -i "$expr" "$file"
  echo "== $label: mutated $file ($expr)"
  if cmp -s "$file" "$file.orig"; then echo "MUTATION DID NOT APPLY"; fi
  echo "\$ node --experimental-strip-types --test --test-name-pattern=\"$pattern\" tests/task.test.ts"
  run "$pattern"
  cp "$file.orig" "$file"; rm "$file.orig"
  [ "$(sha256sum < "$file")" = "$before" ] && echo "-- restored byte-for-byte (sha256 matches the pre-mutation file)" || echo "-- RESTORE MISMATCH"
  echo "\$ node --experimental-strip-types --test --test-name-pattern=\"$pattern\" tests/task.test.ts"
  run "$pattern"
  echo
}
mutate fixer.ts 's/const a: FixerAdmitted | undefined = hasTask(value)/const a: FixerAdmitted | undefined = false/' 'fix_ci admits' 'M1 task admission disabled (always feedback admission)'
mutate fix.ts 's/  if (meta.length) return refuse(/  if (false) return refuse(/' 'drizzle metadata is refused' 'M2 drizzle metadata refusal removed'
mutate fix.ts 's/    if (outside.length) return refuse(/    if (false) return refuse(/' 'outside the PR' 'M3 merge outside-PR-files rule removed'
