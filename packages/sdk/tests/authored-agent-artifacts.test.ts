import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { flow } from '@relayflows/surface';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { JournalClient } from '../src/journal-client.js';
import { sendOk, sendResult, sockPath, startLoopback } from './journal-client-loopback.js';

// A minimal `relayflows-agent-cli-v1` wrapper: enough for `checkAuthoredFlow`'s
// real preflight probe (auth status + model round-trip) to resolve a CLI.
// The step's actual execution never reaches this wrapper in these tests — no
// local-agent worker is attached, so the fake journal server below completes
// every run directly, exactly like `authored-flow.test.ts` does.
function writeWrapper(root: string): string {
  const wrapper = join(root, 'adapter.mjs');
  writeFileSync(wrapper, `#!/usr/bin/env node
import { receiveWrapperRequest } from ${JSON.stringify(resolve('../../testdata/preflight/wrapper-session.mjs'))};
if (process.argv[2] === 'auth') process.exit(0);
await receiveWrapperRequest();
process.stdout.write('unused');
`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

function setupProject(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'authored-artifacts-'));
  const wrapper = writeWrapper(root);
  writeFileSync(join(root, 'flows.json'), JSON.stringify({ cli: wrapper, models: ['test-model'] }));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
  return { root };
}

/**
 * A fake kernel that completes every run it is sent immediately: an agent
 * step "writes" its file as a side effect of `run.start` (standing in for a
 * real CLI, which nothing here spawns — no local-agent worker is attached),
 * and every other step type (the executor's own synthetic `f.done()` marker
 * step included) completes as a trivial deterministic success.
 */
function startArtifactServer(sock: string, root: string): Server {
  let nextRun = 1;
  const stepByRun = new Map<string, { id: string; type: string }>();
  return startLoopback(sock, {
    hello: ctx => sendOk(ctx),
    'run.start': (ctx, params) => {
      const spec = params.spec as Record<string, unknown>;
      const step = (spec['steps'] as Record<string, unknown>[])[0]!;
      const runId = `authored-artifact-run-${nextRun++}`;
      stepByRun.set(runId, { id: step['id'] as string, type: step['type'] as string });
      if (step['type'] === 'agent') {
        mkdirSync(join(root, 'research'), { recursive: true });
        writeFileSync(join(root, 'research', 'notes.md'), 'facts, with sources');
      }
      sendResult(ctx, { run_id: runId, status: 'completed', completion_reason: 'success', completed_steps: 1 });
    },
    'journal.read': (ctx, params) => {
      const step = stepByRun.get(params.run_id as string)!;
      sendResult(ctx, {
        entries: [{
          entry_type: 'step.completed',
          step_id: step.id,
          payload: {
            completionReason: 'success',
            disposition: 'step_done',
            output: step.type === 'agent'
              ? { exit_code: 0, stdout_tail: 'wrote research/notes.md', stderr_tail: '' }
              : { exit_code: 0, stdout_tail: '', stderr_tail: '' },
          },
        }],
      });
    },
  });
}

describe('f.agent artifacts (local-agent path)', () => {
  let server: Server | undefined;
  let path: string | undefined;
  let root: string | undefined;

  afterEach(async () => {
    if (server !== undefined) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (path !== undefined) rmSync(path, { force: true });
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    server = undefined; path = undefined; root = undefined;
  });

  it('reports a file the agent step wrote under its cwd', async () => {
    ({ root } = setupProject());
    path = sockPath();
    server = startArtifactServer(path, root);
    const client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello('authored-artifacts-test');
    try {
      const handle = flow('artifact-test', async (f) => {
        const result = await f.agent('writer', { task: 'write research/notes.md', cwd: root! });
        expect(result.artifacts).toEqual(['research/notes.md']);
        f.done('success');
      });
      const result = await executeAuthoredFlow(handle, client, undefined, {
        flowPath: join(root!, 'artifact-test.flow.ts'),
        localAgentStream: 'test-stream',
      });
      expect(result.completionReason).toBe('success');
    } finally {
      client.close();
    }
  });

  it('reports no artifacts when no local agent is attached', async () => {
    ({ root } = setupProject());
    path = sockPath();
    server = startArtifactServer(path, root);
    const client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello('authored-artifacts-test-2');
    try {
      const handle = flow('artifact-test-no-local', async (f) => {
        const result = await f.agent('writer', { task: 'write research/notes.md', cwd: root!, workspace: 'research' });
        expect(result.artifacts).toEqual([]);
        f.done('success');
      });
      const result = await executeAuthoredFlow(handle, client, undefined, {
        flowPath: join(root!, 'artifact-test-no-local.flow.ts'),
      });
      expect(result.completionReason).toBe('success');
    } finally {
      client.close();
    }
  });
});
