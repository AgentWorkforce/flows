#!/usr/bin/env bash
# Each mutation reverts one behaviour, runs the standalone suite, and restores
# the file byte-for-byte. Run from the repo root:
#   bash examples/babysitter/evidence/standalone/mutations.sh
set -u
B=examples/babysitter
mutate() { # <label> <file> <perl substitution>
  local label=$1 file=$2 expr=$3 backup
  backup=$(mktemp)
  cp "$file" "$backup"
  perl -0pi -e "$expr" "$file"
  echo "=== mutation: $label"
  if cmp -s "$file" "$backup"; then echo "ERROR: substitution did not apply"; cp "$backup" "$file"; rm "$backup"; return 1; fi
  # The runner's own summary: counts, then each failing test once.
  node --experimental-strip-types --test "$B/tests/standalone.test.ts" 2>&1 \
    | awk '/^ℹ (tests|pass|fail) /; /^✖ failing tests:/{f=1; next} f && /^✖ /'
  cp "$backup" "$file"
  echo "restored byte-for-byte: $(cmp -s "$file" "$backup" && echo yes || echo NO)"
  rm "$backup"
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
