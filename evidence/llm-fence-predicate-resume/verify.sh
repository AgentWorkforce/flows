#!/usr/bin/env bash
# Reproduces every claim in this directory. Run from packages/sdk:
#   ../../evidence/llm-fence-predicate-resume/verify.sh
# Each step echoes the literal command, then its complete output and exit code.
set -u
OUT=../../evidence/llm-fence-predicate-resume
KEEP=$(mktemp -d)
FILES="tests/authored-node-runtime.test.ts tests/babysitter-native-extension.test.ts tests/bundle.test.ts tests/canonical-software-factory.test.ts tests/cli-watch.test.ts tests/communication-mixed-resume.test.ts tests/hosted-base-snapshot.test.ts tests/hosted-extension-isolation.test.ts tests/hosted-extension-protocol.test.ts tests/mcp.test.ts tests/stop-process-group.test.ts tests/stuck-run-triage.test.ts tests/worker-cli.test.ts"
show() { echo "\$ $*"; eval "$@" 2>&1; echo "exit=$?"; }

# mutate <name> <src> <sed-expr> <test-file> <test-name>
mutate() {
  local name=$1 src=$2 expr=$3 test=$4 filter=$5
  {
    show "cp $src $KEEP/$(basename "$src")"
    show "sed -i.bak '$expr' $src && rm $src.bak"
    show "git diff --stat -- $src"
    show "npx vitest run $test -t '$filter'"
    show "cp $KEEP/$(basename "$src") $src"
    show "cmp $src $KEEP/$(basename "$src")"
    show "git diff --stat -- $src"
    show "npx vitest run $test -t '$filter'"
  } > "$OUT/mutation-$name.txt"
}
mutate 1-fence src/llm-worker.ts 's/JSON.parse(unfenced(result.stdout_tail))/JSON.parse(result.stdout_tail)/' tests/worker-transcript.test.ts 'fenced reply'
mutate 2-predicate src/authored-flow-executor.ts 's/JSON.stringify(canonical)/JSON.stringify(record)/' tests/authored-agent-artifacts.test.ts 'sorted keys'

# The 13 files that fail in the full suite here, with this change's two source
# files at main (the other changed files are tests outside this list), then as on this branch.
{
  show "cp src/llm-worker.ts src/authored-flow-executor.ts $KEEP/"
  show "git show main:packages/sdk/src/llm-worker.ts > src/llm-worker.ts"
  show "git show main:packages/sdk/src/authored-flow-executor.ts > src/authored-flow-executor.ts"
  show "git diff --stat main -- src/llm-worker.ts src/authored-flow-executor.ts"
  show "npx vitest run $FILES"
  show "cp $KEEP/llm-worker.ts $KEEP/authored-flow-executor.ts src/"
  show "cmp src/llm-worker.ts $KEEP/llm-worker.ts && cmp src/authored-flow-executor.ts $KEEP/authored-flow-executor.ts"
} > "$OUT/thirteen-files-at-main.txt"
show "npx vitest run $FILES" > "$OUT/thirteen-files-on-branch.txt"
show "npm test" > "$OUT/full-suite-on-branch.txt"
