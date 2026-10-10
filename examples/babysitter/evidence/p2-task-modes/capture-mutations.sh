#!/usr/bin/env bash
# Mutation verification: revert one change, run the test that pins it (must be
# red), restore the file byte-for-byte (sha256), run again (must be green).
# Exits nonzero if any mutation does not apply, stays green, fails to restore,
# or the restored test is not green.
set -u
cd "$(dirname "$0")/../.."
status=0
run() { node --experimental-strip-types --test --test-name-pattern="$1" tests/task.test.ts 2>&1 | grep -E '^(✔|✖) |^ℹ (pass|fail)'; }
count() { printf '%s\n' "$1" | sed -n "s/^ℹ $2 //p" | tail -1; }
mutate() { # file, sed expression, test pattern, label
  local file=$1 expr=$2 pattern=$3 label=$4 out pass fail
  cp "$file" "$file.orig"
  local before; before=$(sha256sum < "$file")
  sed -i "$expr" "$file"
  echo "== $label: mutated $file ($expr)"
  if cmp -s "$file" "$file.orig"; then echo "!! MUTATION DID NOT APPLY"; status=1; fi
  echo "\$ node --experimental-strip-types --test --test-name-pattern=\"$pattern\" tests/task.test.ts"
  out=$(run "$pattern"); echo "$out"
  fail=$(count "$out" fail); [ "${fail:-0}" -ge 1 ] || { echo "!! EXPECTED RED, GOT fail=${fail:-?}"; status=1; }
  cp "$file.orig" "$file"; rm "$file.orig"
  if [ "$(sha256sum < "$file")" = "$before" ]; then echo "-- restored byte-for-byte (sha256 matches the pre-mutation file)"; else echo "!! RESTORE MISMATCH"; status=1; fi
  echo "\$ node --experimental-strip-types --test --test-name-pattern=\"$pattern\" tests/task.test.ts"
  out=$(run "$pattern"); echo "$out"
  pass=$(count "$out" pass); fail=$(count "$out" fail)
  [ "${fail:-1}" -eq 0 ] && [ "${pass:-0}" -ge 1 ] || { echo "!! EXPECTED GREEN, GOT pass=${pass:-?} fail=${fail:-?}"; status=1; }
  echo
}
mutate fixer.ts 's/const a: FixerAdmitted | undefined = hasTask(value)/const a: FixerAdmitted | undefined = false/' 'fix_ci admits' 'M1 task admission disabled (always feedback admission)'
mutate fix.ts 's/  if (meta.length) return refuse(/  if (false) return refuse(/' 'drizzle metadata is refused' 'M2 drizzle metadata refusal removed'
mutate fix.ts 's/    if (outside.length) return refuse(/    if (false) return refuse(/' 'outside the PR' 'M3 merge outside-PR-files rule removed'
mutate task-admission.ts 's/wanted.has(r.thread ?? r.id)/wanted.has(r.id)/' 'matched by its root' 'M4 thread filter back on comment ids'
mutate fixer.ts 's/    if (unanswered.length) {/    if (false) {/' 'gets no reply' 'M5 requested-thread coverage check removed'
mutate task.ts 's/!label(c.name, NAME_MAX_CHARS)/!bounded(c.name, NAME_MAX_CHARS)/' 'check names never reach' 'M6 control characters allowed in check names'
mutate merge.ts 's/  if (mergeHead !== c.trunkSha || (failure !== undefined \&\& conflicts.length === 0))/  if (false)/' 'does not start the merge' 'M7 merge-start check removed'
mutate fix.ts 's/c.limits.summaryChars - why.length/Infinity/' 'within the summary limit' 'M8 unpublished summary uncapped'
mutate fix.ts 's/    if (untouched.length) return refuse(/    if (false) return refuse(/' 'unresolved binary conflict' 'M9 binary-conflict refusal removed'
mutate fix.ts 's/      unreadable = true;/      throw error;/' 'too large to even read' 'M10 buffer overflow fails the run again'
echo "exit=$status"
exit $status
