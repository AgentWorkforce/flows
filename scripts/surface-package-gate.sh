#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pack_dir="$(mktemp -d /tmp/relayflows-surface-pack.XXXXXX)"
consumer_dir="$(mktemp -d /tmp/relayflows-surface-consumer.XXXXXX)"
trap 'rm -rf "$pack_dir" "$consumer_dir"' EXIT

cd "$repo_root/surface"
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run test
bun run typecheck:regressions
bun pm pack --destination "$pack_dir"

tarball="$(find "$pack_dir" -maxdepth 1 -type f -name '*.tgz' -print -quit)"
if [[ -z "$tarball" ]]; then
  echo "surface package gate: bun pm pack produced no tarball" >&2
  exit 1
fi

cd "$consumer_dir"
cat > package.json <<'JSON'
{
  "name": "relayflows-surface-packed-consumer",
  "private": true,
  "type": "module"
}
JSON
bun add "$tarball"

node --input-type=module - <<'NODE'
import { flow } from '@relayflows/surface';
import { getFlowDefinition } from '@relayflows/surface/runtime';

let completionReason;
const handle = flow(
  'packed-runtime-consumer',
  { identity: 'package-gate' },
  async (f) => f.done('success'),
);
const definition = getFlowDefinition(handle);
await definition.body({ done: (reason) => { completionReason = reason; } });

if (definition.header.identity !== 'package-gate') {
  throw new Error('packed runtime consumer lost the authored header');
}
if (completionReason !== 'success') {
  throw new Error('packed runtime consumer could not invoke the authored body');
}
console.log(`PACKED_RUNTIME_OK name=${definition.name} completionReason=${completionReason}`);
NODE

cat > consume.mts <<'TS'
import {
  flow,
  type AgentOptions,
  type AgentResult,
  type CloudHelper,
  type Ctx,
  type FlowHandle,
  type FlowHeader,
  type Step,
} from '@relayflows/surface';
import {
  getFlowDefinition,
  type AuthoredFlowDefinition,
} from '@relayflows/surface/runtime';

const body = async (f: Ctx): Promise<void> => {
  const ran: Step<string> = f.run('true');
  await ran.gate(Boolean);
  const options: AgentOptions = { task: 'review' };
  const agent: Step<AgentResult> = f.agent('reviewer', options);
  await agent;
  f.done('success');
};
const header: FlowHeader = { identity: 'packed-type-consumer' };
const handle: FlowHandle = flow('packed-type-consumer', header, body);
const definition: AuthoredFlowDefinition = getFlowDefinition(handle);
const helper: CloudHelper | undefined = undefined;
void definition;
void helper;
TS

cat > tsconfig.consumer.json <<'JSON'
{
  "compilerOptions": {
    "noEmit": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "strict": true,
    "skipLibCheck": false,
    "types": []
  },
  "include": ["consume.mts"]
}
JSON

"$repo_root/surface/node_modules/.bin/tsc" -p tsconfig.consumer.json
echo "PACKED_TYPESCRIPT_OK"

mkdir -p "$repo_root/sdk/node_modules/@relayflows"
if [[ ! -e "$repo_root/sdk/node_modules/@relayflows/surface" ]]; then
  ln -s ../../../surface "$repo_root/sdk/node_modules/@relayflows/surface"
fi
cd "$repo_root"
surface/node_modules/.bin/vitest run sdk/tests/authored-flow.test.ts --root "$repo_root"
