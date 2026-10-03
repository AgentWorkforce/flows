#!/usr/bin/env bash
# Each mutation reverts one behaviour, runs the standalone suite, and restores
# the file byte-for-byte. Exits nonzero if any mutation survives, does not
# apply, or is not restored. Run from the repo root:
#   bash examples/babysitter/evidence/standalone/mutations.sh
set -u
B=examples/babysitter
active_file='' active_backup=''
restore() {
  if [ -n "$active_backup" ]; then cp "$active_backup" "$active_file"; rm -f "$active_backup"; fi
  active_file='' active_backup=''
}
# An interrupted run must not leave a source file mutated.
trap 'restore; exit 130' INT TERM
trap restore EXIT
status=0
mutate() { # <label> <file> <perl substitution>
  local label=$1 file=$2 expr=$3 output failed
  active_file=$file active_backup=$(mktemp)
  cp "$file" "$active_backup"
  perl -0pi -e "$expr" "$file"
  echo "=== mutation: $label"
  if cmp -s "$file" "$active_backup"; then echo "ERROR: substitution did not apply"; restore; status=1; return; fi
  output=$(node --experimental-strip-types --test "$B/tests/standalone.test.ts" 2>&1)
  # The runner's own summary: counts, then each failing test once.
  printf '%s\n' "$output" | awk '/^ℹ (tests|pass|fail) /; /^✖ failing tests:/{f=1; next} f && /^✖ /'
  failed=$(printf '%s\n' "$output" | awk '/^ℹ fail /{print $3}')
  if [ "${failed:-0}" -eq 0 ]; then echo "ERROR: mutation survived"; status=1; fi
  local backup=$active_backup
  cp "$backup" "$file"
  echo "restored byte-for-byte: $(cmp -s "$file" "$backup" && echo yes || { status=1; echo NO; })"
  rm -f "$backup"; active_file='' active_backup=''
}
mutate 'fail-open on a missing originContext verdict' "$B/origin.ts" \
  's/if \(x\.status !== .ok. && x\.status !== .degraded.\) return undefined;/if (x.status === "never") return undefined;/'
mutate 'skip the reread-before-report check' "$B/standalone.ts" \
  's/if \(final\.headSha !== head \|\| outOfScope\(final, c, configured\.label\)\) \{/if (false) {/'
mutate 'bare delimiter the prompt can close' "$B/origin.ts" \
  's/return `\$\{bar\} \$\{label\}`;/return label;/'
mutate 'decision key from the delivery id' "$B/standalone.ts" \
  's/observation\(c, wake, bound\)/observation(c, { ...wake, id: wake.id + deliveryId }, bound)/'
mutate 'publish the prompt the agent echoes' "$B/standalone.ts" \
  's/neutralise\(result\.summary, origin\.firstPrompt\)/neutralise(result.summary, "\\u0000")/'
mutate 'keep a duplicate report for the same head' "$B/standalone.ts" \
  's/if \(!await settle\(f, pr, id, configured\.botLogin, marker\)\) \{/if (false) {/'
echo "all mutations caught and restored: $([ $status -eq 0 ] && echo yes || echo NO)"
exit $status
