#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
evidence_dir="$repo_root/evidence/native-parallel-review8"
volume=ms-flows-parallel-r7
stage=ms-flows-parallel-f5-stage

# Deep forcing isolates the executor's early-failure rule. Bypass only the
# preload admission gate in this scratch SDK so PL7mid pins parallel mode;
# keep its later intrinsic-integrity check intact.
docker run -d --rm --platform linux/arm64 -v "$volume:/w" --name "$stage" node:22-trixie sleep infinity > "$evidence_dir/f5-stage-id.log"
docker cp "$evidence_dir/h7-f5.mjs" "$stage:/w/review8/h7-f5.mjs"
docker exec "$stage" sh -c '
  rm -rf /w/deep-f5/packages/sdk
  mkdir -p /w/deep-f5/packages
  cp -a /w/deep/packages/sdk /w/deep-f5/packages/
  sed -i "s/function authoredProcessHasPreload() {/function authoredProcessHasPreload() { return false;/" /w/deep-f5/packages/sdk/dist/authored-flow-lifecycle.js
  cp /w/deep-f5/packages/sdk/dist/authored-flow-executor.js /w/deep-f5/packages/sdk/dist/authored-flow-executor.js.pristine
  sha256sum /w/deep-f5/packages/sdk/dist/authored-flow-executor.js
' > "$evidence_dir/f5-stage.log"
docker stop "$stage" > /dev/null

run_case() {
  local tag=$1
  local reps=$2
  local log=$3
  docker run --rm --init --platform linux/arm64 -v "$volume:/w" -w /w/review8 node:22-trixie \
    node --no-warnings h7-f5.mjs s7.mjs PL7mid --reps="$reps" --conc=3 --tag="$tag" --sides=deep:deep \
    > "$evidence_dir/$log" 2>&1
  rg '^SUMMARY' "$evidence_dir/$log"
}

run_case r8f5-before 6 h7-f5-before.log
docker run --rm --platform linux/arm64 -v "$volume:/w" node:22-trixie sh -c '
  sed -i "s/await Promise.race(\[bodyPromise, parallelFailure\]);/await bodyPromise;/" /w/deep-f5/packages/sdk/dist/authored-flow-executor.js
  ! cmp -s /w/deep-f5/packages/sdk/dist/authored-flow-executor.js.pristine /w/deep-f5/packages/sdk/dist/authored-flow-executor.js
  ! grep -Fq "await Promise.race([bodyPromise, parallelFailure]);" /w/deep-f5/packages/sdk/dist/authored-flow-executor.js
  grep -n "await bodyPromise;" /w/deep-f5/packages/sdk/dist/authored-flow-executor.js
' > "$evidence_dir/f5-mutated.log"
run_case r8f5-mutant 1 h7-f5-mutant.log
docker run --rm --platform linux/arm64 -v "$volume:/w" node:22-trixie sh -c '
  cp /w/deep-f5/packages/sdk/dist/authored-flow-executor.js.pristine /w/deep-f5/packages/sdk/dist/authored-flow-executor.js
  cmp /w/deep-f5/packages/sdk/dist/authored-flow-executor.js.pristine /w/deep-f5/packages/sdk/dist/authored-flow-executor.js
  sha256sum /w/deep-f5/packages/sdk/dist/authored-flow-executor.js
' > "$evidence_dir/f5-restored.log"
run_case r8f5-restored 6 h7-f5-restored.log

python3 - "$evidence_dir" <<'PY'
from pathlib import Path
import json, sys
root=Path(sys.argv[1])
def read(name):
    return [json.loads(line) for line in (root/name).read_text().splitlines() if line.startswith('{')]
for name in ['h7-f5-before.log','h7-f5-restored.log']:
    rows=read(name)
    assert len(rows)==6 and all(row['fresh'] and row['code']==1 and row['mode']=='parallel'
                                and not row['replay'] for row in rows), name
rows=read('h7-f5-mutant.log')
assert len(rows)==1 and rows[0]['fresh'] and rows[0]['code']=='timeout', rows
assert (root/'f5-stage.log').read_text()==(root/'f5-restored.log').read_text()
print('F5: 6/6 prompt failures before mutation, 1/1 timeout with race removed, 6/6 prompt failures after byte-for-byte restore')
PY
