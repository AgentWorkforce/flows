import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { JournalClient } from '../src/journal-client.js';
import { AgentWorker } from '../src/worker.js';
import { LlmWorker } from '../src/llm-worker.js';
import type { StepDispatchEvent } from '../src/protocol.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function clientWithFeature(scoped: boolean): JournalClient {
  const client = new EventEmitter() as EventEmitter & Record<string, unknown>;
  client.supportsFeature = (name: string) => name === 'step_secret_scoping' && scoped;
  client.workerAttach = async () => ({});
  client.stepHeartbeat = async () => ({ lease_deadline_ms: Date.now() + 30_000 });
  client.stepComplete = async () => ({});
  return client as unknown as JournalClient;
}

it.each(['agent', 'llm'] as const)('%s worker uses the negotiated daemon capability for its real child', async kind => {
  const root = mkdtempSync(join(tmpdir(), `flows-${kind}-capability-`));
  roots.push(root);
  const observed = join(root, 'observed.json');
  const claude = join(root, 'claude');
  writeFileSync(claude, `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(observed)}, JSON.stringify({
  native: process.env.NATIVE_API_TOKEN ?? null,
  signalRead: process.env.RELAYFLOW_V2_SIGNAL_READ_TOKEN ?? null,
  ghConfig: process.env.GH_CONFIG_DIR ?? null,
  askpass: process.env.GIT_ASKPASS ?? null,
  hardeningKey: process.env.GIT_CONFIG_KEY_1 ?? null,
  hardeningValue: process.env.GIT_CONFIG_VALUE_1 ?? null,
  useBedrock: process.env.CLAUDE_CODE_USE_BEDROCK ?? null,
  awsKey: process.env.AWS_ACCESS_KEY_ID ?? null,
  awsSecret: process.env.AWS_SECRET_ACCESS_KEY ?? null,
  awsRegion: process.env.AWS_REGION ?? null,
}));
process.stdout.write(JSON.stringify({ type: 'result', result: 'ok',
  usage: { input_tokens: 2, output_tokens: 1 } }) + '\\n');
`);
  chmodSync(claude, 0o755);
  const source = { PATH: process.env.PATH, HOME: root, NATIVE_API_TOKEN: 'native-secret',
    RELAY_SECRET_ENV_NAMES: '["NATIVE_API_TOKEN","CLAUDE_CODE_USE_BEDROCK","AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY"]',
    RELAY_PLATFORM_AGENT_ENV_NAMES: '["CLAUDE_CODE_USE_BEDROCK","AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_REGION"]',
    RELAYFLOW_V2_SIGNAL_READ_TOKEN: 'private-signal-token',
    CLAUDE_CODE_USE_BEDROCK: '1', AWS_ACCESS_KEY_ID: 'bedrock-key',
    AWS_SECRET_ACCESS_KEY: 'bedrock-secret', AWS_REGION: 'eu-west-1',
    GH_CONFIG_DIR: join(root, 'gh'), GIT_ASKPASS: join(root, 'askpass'),
    GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null' };
  for (const scoped of [true, false]) {
    const client = clientWithFeature(scoped);
    const worker = kind === 'agent'
      ? new AgentWorker(client, { workerId: 'capability-agent', pins: { workspace: [], streams: [] },
        environment: source, runRoot: root })
      : new LlmWorker(client, 'capability-llm', 1, source);
    const errors: unknown[] = [];
    worker.on('error', error => errors.push(error));
    await worker.attach();
    (client as unknown as EventEmitter).emit('step.dispatch', {
      run_id: 'run', step_id: kind, step_type: kind, attempt: 1,
      idempotency_key: `key-${scoped}`, lease_id: 'lease', lease_deadline_ms: Date.now() + 30_000,
      pins: { workspace: [], streams: [] },
      spec: { cli: claude, instruction: 'task', prompt: 'task', model: 'unpriced-test-model' },
    } satisfies StepDispatchEvent);
    await worker.close();
    expect(errors).toEqual([]);
    expect(JSON.parse(readFileSync(observed, 'utf8'))).toEqual({
      native: scoped ? null : 'native-secret', signalRead: null,
      ghConfig: join(root, 'gh'), askpass: join(root, 'askpass'),
      hardeningKey: 'core.hooksPath', hardeningValue: '/dev/null',
      useBedrock: '1', awsKey: 'bedrock-key', awsSecret: 'bedrock-secret', awsRegion: 'eu-west-1',
    });
  }
}, 30_000);
