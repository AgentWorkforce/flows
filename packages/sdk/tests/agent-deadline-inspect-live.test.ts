import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AgentWorker } from '../src/worker.js';
import { compileSpec, toKernelSpec } from '../src/compile.js';
import type { KernelRunSpec } from '../src/spec.js';
import { SPEC_SCHEMA_VERSION } from '../src/spec.js';
import { chainFixture } from './flow-chain-fixture.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

it('a CLI deadline journals the dirty pin and the next attempt inspects the file', async () => {
  const f = chainFixture();
  cleanups.push(() => f.close());
  const workspace = join(f.root, 'workspace');
  const kept = join(workspace, 'kept.txt');
  const second = join(workspace, 'second.txt');
  const seen = join(f.root, 'instructions.log');
  mkdirSync(workspace);
  const cli = join(f.root, 'claude');
  writeFileSync(cli, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const dash = process.argv.indexOf('--');
const instruction = dash === -1 ? '' : process.argv[dash + 1] ?? '';
appendFileSync(${JSON.stringify(seen)}, instruction + '\\n---\\n');
if (instruction.includes('Previous attempt')) {
  const body = readFileSync(${JSON.stringify(kept)}, 'utf8');
  writeFileSync(${JSON.stringify(second)}, body);
  process.stdout.write(body);
  process.exit(0);
}
writeFileSync(${JSON.stringify(kept)}, 'still-here\\n');
setTimeout(() => {}, 30_000);
`);
  chmodSync(cli, 0o755);
  const spec = toKernelSpec(compileSpec({
    version: SPEC_SCHEMA_VERSION,
    steps: [{
      id: 'agent', type: 'agent', instruction: 'edit the workspace', cli,
      model: 'unpriced-test-model', recoveryMode: 'reset', maxIterations: 1,
      timeoutMs: 800, surfaces: { workspace: [{ surface: 'repo' }] },
    }],
  })) as KernelRunSpec;
  const retry = spec.steps[0]?.retry;
  if (retry === undefined) throw new Error('agent spec has no retry');
  retry.initial_backoff_ms = 0;
  retry.max_backoff_ms = 0;
  retry.multiplier = 1;
  retry.jitter_percent = 0;
  retry.max_transport_retries = 1;

  const client = await f.connect();
  const worker = new AgentWorker(client, {
    workerId: 'deadline-inspect',
    pins: { workspace: [{ surface: 'repo', revision_id: 'rev-clean' }], streams: [] },
    dataDir: f.data,
    runRoot: workspace,
  });
  const errors: unknown[] = [];
  worker.on('error', error => errors.push(error));
  await worker.attach();
  const started = await client.runStart(spec);

  const deadline = Date.now() + 25_000;
  let timedOut: { payload?: Record<string, unknown> } | undefined;
  while (timedOut === undefined) {
    if (Date.now() > deadline) {
      throw new Error(`deadline did not journal a retry: ${JSON.stringify(errors)} ${readFileSync(seen, 'utf8')}`);
    }
    const page = await client.journalRead(started.run_id, 1, 1000);
    timedOut = (page.entries as Array<{ entry_type: string; payload?: Record<string, unknown> }>)
      .find(entry => entry.entry_type === 'step.completed'
        && entry.payload?.['completionReason'] === 'timeout'
        && entry.payload?.['disposition'] === 'retry');
    if (timedOut === undefined) await new Promise(resolve => setTimeout(resolve, 25));
  }
  expect(errors, JSON.stringify(errors)).toEqual([]);
  const tail = JSON.stringify(timedOut.payload?.['trajectory_tail']);
  expect(tail).toContain('kept.txt');
  const endPins = timedOut.payload?.['end_pins'] as { workspace?: Array<{ revision_id?: string }> };
  const revision = endPins.workspace?.[0]?.revision_id ?? '';
  const stamp = createHash('sha256').update('kept.txt').digest('hex').slice(0, 16);
  expect(revision).toBe(`rev-clean+${stamp}`);
  const completions = (await client.journalRead(started.run_id, 1, 1000)).entries as Array<{
    entry_type: string; attempt?: number; payload?: { disposition?: string };
  }>;
  expect(completions.filter(entry => entry.entry_type === 'step.completed' && entry.attempt === 1)
    .map(entry => entry.payload?.disposition)).toEqual(['retry']);

  await client.runResume(started.run_id);
  const until = Date.now() + 20_000;
  while (true) {
    try {
      if (readFileSync(second, 'utf8') === 'still-here\n') break;
    } catch { /* not written yet */ }
    if (Date.now() > until) {
      throw new Error(`continuation did not write second.txt: ${readFileSync(seen, 'utf8')}`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  expect(readFileSync(second, 'utf8')).toBe('still-here\n');
  expect(readFileSync(seen, 'utf8')).toContain('Previous attempt (journaled):');
  expect(readFileSync(seen, 'utf8')).toContain('kept.txt');
  await worker.close();
}, 45_000);
