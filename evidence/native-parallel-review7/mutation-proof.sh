#!/usr/bin/env bash
set -euo pipefail

evidence_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
sdk_dir=$(cd "$evidence_dir/../../packages/sdk" && pwd)
cd "$sdk_dir"

mutate_and_check() (
  set -euo pipefail
  local label=$1 file=$2 original=$3 replacement=$4 expected=$5
  shift 5
  local backup before after failure_log pass_log
  backup=$(mktemp)
  cp "$file" "$backup"
  trap 'cp "$backup" "$file"; rm -f "$backup"' EXIT
  before=$(shasum -a 256 "$file" | awk '{print $1}')
  failure_log="$evidence_dir/mut-$label-fail.log"
  pass_log="$evidence_dir/mut-$label-pass.log"

  python3 - "$file" "$original" "$replacement" <<'PY'
from pathlib import Path
import sys
file, original, replacement = sys.argv[1:]
source = Path(file).read_text()
assert source.count(original) == 1, (file, original)
Path(file).write_text(source.replace(original, replacement))
PY

  printf '%s\n' "MUTATION $label" "COMMAND npx vitest run $*"
  if npx vitest run "$@" > "$failure_log" 2>&1; then
    cat "$failure_log"
    echo "ERROR: $label mutation did not fail"
    exit 1
  fi
  if ! rg -F "$expected" "$failure_log" >/dev/null; then
    cat "$failure_log"
    echo "ERROR: $label failed for a different reason"
    exit 1
  fi
  cat "$failure_log"
  cp "$backup" "$file"
  after=$(shasum -a 256 "$file" | awk '{print $1}')
  test "$before" = "$after"
  cmp "$backup" "$file"
  printf '%s\n' "RESTORED $label SHA256 $after"
  npx vitest run "$@" > "$pass_log" 2>&1
  cat "$pass_log"
  trap - EXIT
  rm -f "$backup"
)

mutate_and_check f1 src/authored-step-graph.ts \
  '&& !this.registeredAggregates.has(current) && !this.certifiedMembers.has(current)' \
  '&& !this.registeredAggregates.has(current) && false' \
  'expected false to be true' \
  tests/authored-step-graph.test.ts -t 'does not trust a user-built join merely because it is a combinator member'

mutate_and_check f2-binding src/authored-parallel-eligibility.ts \
  'return importsSurfaceFlow && definesDefaultBody && !unsafe;' \
  'return definesDefaultBody && !unsafe;' \
  'expected true to be false' \
  tests/authored-parallel-eligibility.test.ts -t 'requires the exported arrow to be the actual body from the direct Surface binding'

mutate_and_check f2-body src/authored-parallel-eligibility.ts \
  'if (args[args.length - 1]!.getText(file) !== bodySource) return false;' \
  '/* mutation: skip body identity */' \
  'expected true to be false' \
  tests/authored-parallel-eligibility.test.ts -t 'requires the exported arrow to be the actual body from the direct Surface binding'

mutate_and_check f3 src/authored-flow-lifecycle.ts \
  '|| Promise.resolve !== nativePromiseResolve || Promise.reject !== nativePromiseReject' \
  '|| Promise.reject !== nativePromiseReject' \
  'resolve: expected true to be false' \
  tests/authored-flow-lifecycle-executor.test.ts -t 'detects replacement of every Promise primitive used by parallel joins'
