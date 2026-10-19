#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pack_dir="$(mktemp -d /tmp/relayflows-surface-pack.XXXXXX)"
consumer_dir="$(mktemp -d /tmp/relayflows-surface-consumer.XXXXXX)"
trap 'rm -rf "$pack_dir" "$consumer_dir"' EXIT

cd "$repo_root/packages/surface"
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

npm ci --prefix "$repo_root/packages/sdk" --ignore-scripts

# Override the registry-installed @relayflows/surface with the freshly-packed
# local tarball. Without this the SDK's typecheck reads the last-published
# surface's types — an SDK change adding a new surface import fails against a
# published surface that hasn't shipped it yet, keeping the SDK PR draft
# forever. `--no-save` keeps package.json / package-lock.json unchanged so
# this override does not leak into the committed manifest.
npm install "$tarball" --prefix "$repo_root/packages/sdk" --no-save --ignore-scripts

npm run typecheck --prefix "$repo_root/packages/sdk"

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

const invalidHeaders = [
  { identitty: 'typo' },
  [],
  null,
  { memory: null },
  { memory: { typo: true } },
  { tools: null },
  { tools: { typo: [] } },
  { tools: { mcp: 'github' } },
  { tools: { mcp: ['github', 42] } },
];
for (const [index, header] of invalidHeaders.entries()) {
  try {
    flow(`packed-invalid-${index}`, header, async () => undefined);
    throw new Error(`packed runtime accepted invalid header ${index}`);
  } catch (error) {
    if (!(error instanceof TypeError) || !error.message.includes('unsupported_header')) {
      throw error;
    }
  }
}

const forged = { name: 'packed-forgery' };
Object.defineProperty(forged, Symbol.for('@relayflows/surface.authored-definition.v1'), {
  value: Object.freeze({
    name: 'packed-forgery',
    header: Object.freeze({}),
    body: async () => undefined,
  }),
  enumerable: false,
  configurable: false,
  writable: false,
});
try {
  getFlowDefinition(Object.freeze(forged));
  throw new Error('packed runtime accepted a forged handle');
} catch (error) {
  if (!(error instanceof TypeError)
    || error.message !== 'expected an @relayflows/surface flow handle') {
    throw error;
  }
}
console.log(`PACKED_RUNTIME_REFUSAL_OK invalidHeaders=${invalidHeaders.length} forgedHandle=refused`);
NODE

cat > consume.mts <<'TS'
import {
  flow,
  type AgentOptions,
  type AgentResult,
  type CloudHelper,
  type SlackHelper,
  type SlackReceipt,
  type CompletionReason,
  type Ctx,
  type FlowHandle,
  type FlowHeader,
  type RunCompletionReason,
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
  const slack: SlackHelper = f.slack;
  const post: Step<SlackReceipt> = slack.post('#test', 'hi');
  await post;
  await f.slack.post('#test', 'typed');
  f.done('success');
};
const header: FlowHeader = { identity: 'packed-type-consumer' };
const handle: FlowHandle = flow('packed-type-consumer', header, body);
const definition: AuthoredFlowDefinition = getFlowDefinition(handle);
const stepReason: CompletionReason = 'verification_failed';
const runReason: RunCompletionReason = 'step_failed';
const finishRun = (f: Ctx, reason: RunCompletionReason): void => f.done(reason);
const refuseStepReason = (f: Ctx, reason: CompletionReason): void => {
  // @ts-expect-error step-attempt reasons cannot complete a whole flow.
  f.done(reason);
};
const helper: CloudHelper | undefined = undefined;
void definition;
void helper;
void stepReason;
void runReason;
void finishRun;
void refuseStepReason;
TS

cat > tsconfig.consumer.json <<'JSON'
{
  "compilerOptions": {
    "noEmit": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "strict": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["consume.mts"]
}
JSON

"$repo_root/packages/surface/node_modules/.bin/tsc" -p tsconfig.consumer.json
echo "PACKED_TYPESCRIPT_OK"

cd "$repo_root/packages/sdk"
./node_modules/.bin/vitest run tests/authored-flow.test.ts
