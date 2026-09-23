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
 * A fake kernel that completes every run it is sent immediately. For an agent
 * step it journals what a real AgentWorker journals: the CLI wrapper output
 * with the worker-measured `artifacts` list (the worker that spawned the CLI
 * diffed its cwd; nothing here spawns anything). Every other step type (the
 * executor's own synthetic `f.done()` marker step included) completes as a
 * trivial deterministic success. `artifactsFor` decides what the journal says
 * for the agent step — the disk is never consulted by the authored runtime.
 */
function startArtifactServer(sock: string, root: string, artifactsFor: (transport: unknown) => string[] | undefined = () => ['research/notes.md']): Server {
  let nextRun = 1;
  const stepByRun = new Map<string, { id: string; type: string; artifacts: string[] | undefined }>();
  return startLoopback(sock, {
    hello: ctx => sendOk(ctx),
    'run.start': (ctx, params) => {
      const spec = params.spec as Record<string, unknown>;
      const step = (spec['steps'] as Record<string, unknown>[])[0]!;
      const runId = `authored-artifact-run-${nextRun++}`;
      stepByRun.set(runId, { id: step['id'] as string, type: step['type'] as string,
        artifacts: step['type'] === 'agent' ? artifactsFor(step['transport']) : undefined });
      if (step['type'] === 'agent') {
        // The agent "wrote" a file; the disk state is irrelevant to the
        // authored runtime, which must read the journal instead.
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
              ? { exit_code: 0, stdout_tail: 'wrote research/notes.md', stderr_tail: '',
                  ...(step.artifacts === undefined ? {} : { artifacts: step.artifacts }) }
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

  it('reports the artifacts the worker journaled for the agent step', async () => {
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

  it('reports no artifacts for transport: relay — the worker journals none for a remote agent', async () => {
    ({ root } = setupProject());
    path = sockPath();
    server = startArtifactServer(path, root, transport => transport === 'relay' ? undefined : ['research/notes.md']);
    const client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello('authored-artifacts-test-relay');
    try {
      const handle = flow('artifact-test-relay', async (f) => {
        // The fake server still performs its "the agent wrote a file" side
        // effect for any agent-type step, but a relay-transport step ran on
        // a remote host — this process's filesystem is not where it wrote,
        // so the local snapshot must not be trusted here.
        const result = await f.agent('writer', { task: 'write research/notes.md', cwd: root!, transport: 'relay' });
        expect(result.artifacts).toEqual([]);
        f.done('success');
      });
      const result = await executeAuthoredFlow(handle, client, undefined, {
        flowPath: join(root!, 'artifact-test-relay.flow.ts'),
        localAgentStream: 'test-stream',
      });
      expect(result.completionReason).toBe('success');
    } finally {
      client.close();
    }
  });

  it('reports the journaled artifacts whatever worker ran the step, and [] when it journaled none', async () => {
    ({ root } = setupProject());
    path = sockPath();
    // A worker other than the local agent (a workspace-pinned one here)
    // journals its own measurement; a malformed or absent list reads as [].
    let calls = 0;
    server = startArtifactServer(path, root, () => (calls++ === 0 ? ['research/notes.md'] : undefined));
    const client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello('authored-artifacts-test-2');
    try {
      const handle = flow('artifact-test-no-local', async (f) => {
        const first = await f.agent('writer', { task: 'write research/notes.md', cwd: root!, workspace: 'research' });
        expect(first.artifacts).toEqual(['research/notes.md']);
        const second = await f.agent('writer-again', { task: 'write nothing', cwd: root!, workspace: 'research' });
        expect(second.artifacts).toEqual([]);
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

describe('predicate verdicts recorded on the root run', () => {
  let server: Server | undefined;
  let path: string | undefined;
  afterEach(async () => {
    if (server !== undefined) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (path !== undefined) rmSync(path, { force: true });
    server = undefined; path = undefined;
  });

  it('concurrent gates on resume share one stream load, reuse the recorded verdicts and never re-run a closure', async () => {
    path = sockPath();
    // A root run that already carries verdicts for both gates; the stream
    // read is answered slowly so both gates are in flight before it resolves.
    const recorded = [
      { gate: 'predicate', step: 'run-1', verdict: 'pass', because: 'first' },
      { gate: 'predicate', step: 'run-2', verdict: 'pass', because: 'second' },
    ];
    let streamReads = 0;
    const appended: unknown[] = [];
    let nextRun = 1;
    const specs = new Map<string, string>();
    server = startLoopback(path, {
      hello: ctx => sendOk(ctx),
      'stream.read': (ctx, params) => {
        if (params.stream !== 'predicate-gates') { sendResult(ctx, { messages: [], next_offset: 0 }); return; }
        streamReads += 1;
        const from = params.from_offset as number;
        setTimeout(() => sendResult(ctx, from === 0
          ? { messages: recorded.map(message => ({ message })), next_offset: recorded.length }
          : { messages: [], next_offset: from }), 50);
      },
      // Recorded per stream: the authored child index writes to its own stream
      // on every operation, and this test is about the verdict stream.
      'stream.append': (ctx, params) => {
        if (params.stream === 'predicate-gates') appended.push(params.message);
        sendResult(ctx, { offset: appended.length });
      },
      'run.start': (ctx, params) => {
        const spec = params.spec as { steps: Array<{ id: string; command?: string }> };
        const runId = `resume-run-${nextRun++}`;
        specs.set(runId, spec.steps[0]!.id + '|' + (spec.steps[0]!.command ?? ''));
        sendResult(ctx, { run_id: runId, status: 'completed', completion_reason: 'success', completed_steps: 1 });
      },
      'journal.read': (ctx, params) => {
        const [id] = specs.get(params.run_id as string)!.split('|');
        sendResult(ctx, { entries: [{ entry_type: 'step.completed', step_id: id, payload: {
          completionReason: 'success', disposition: 'step_done', output: { exit_code: 0, stdout_tail: 'x', stderr_tail: '' } } }] });
      },
    });
    const client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello('predicate-resume-test');
    let closureCalls = 0;
    try {
      const handle = flow('predicate-resume', async (f) => {
        await Promise.all([
          f.run('echo a').gate(() => { closureCalls += 1; return false; }, 'first'),
          f.run('echo b').gate(() => { closureCalls += 1; return false; }, 'second'),
        ]);
        f.done('success');
      });
      const result = await executeAuthoredFlow(handle, client, undefined, { rootRunId: 'root-1' });
      expect(result.completionReason).toBe('success');
    } finally {
      client.close();
    }
    // The closures would have said "fail"; the recorded "pass" verdicts won,
    // through a single stream load, and nothing new was appended.
    expect(closureCalls).toBe(0);
    expect(streamReads).toBeLessThanOrEqual(2);
    expect(appended).toEqual([]);
    const gateSpecs = [...specs.values()].filter(s => s.includes('.gate|'));
    expect(gateSpecs).toHaveLength(2);
    for (const spec of gateSpecs) expect(spec).toContain('"verdict":"pass"');
  });
  it('a resumed verdict read back with sorted keys lowers the same gate command as the first run', async () => {
    path = sockPath();
    // The kernel returns stream messages with their keys sorted; the first run
    // appended them in authoring order. Both runs must lower one command, or
    // the gate run's admission key refuses the resume.
    const stream: Record<string, unknown>[] = [];
    const commands: string[] = [];
    let nextRun = 1;
    const specs = new Map<string, string>();
    server = startLoopback(path, {
      hello: ctx => sendOk(ctx),
      'stream.read': (ctx, params) => {
        const from = params.from_offset as number;
        const page = params.stream === 'predicate-gates' ? stream.slice(from) : [];
        const sorted = page.map(m => Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b))));
        sendResult(ctx, { messages: sorted.map(message => ({ message })), next_offset: from + page.length });
      },
      'stream.append': (ctx, params) => {
        if (params.stream === 'predicate-gates') stream.push(params.message as Record<string, unknown>);
        sendResult(ctx, { offset: stream.length });
      },
      'run.start': (ctx, params) => {
        const step = (params.spec as { steps: Array<{ id: string; command?: string }> }).steps[0]!;
        if (step.id.endsWith('.gate')) commands.push(step.command!);
        const runId = `sorted-run-${nextRun++}`;
        specs.set(runId, step.id);
        sendResult(ctx, { run_id: runId, status: 'completed', completion_reason: 'success', completed_steps: 1 });
      },
      'journal.read': (ctx, params) => {
        sendResult(ctx, { entries: [{ entry_type: 'step.completed', step_id: specs.get(params.run_id as string), payload: {
          completionReason: 'success', disposition: 'step_done', output: { exit_code: 0, stdout_tail: 'x', stderr_tail: '' } } }] });
      },
    });
    const client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello('predicate-sorted-test');
    try {
      const handle = flow('predicate-sorted', async (f) => {
        await f.run('echo a').gate(() => true, 'plan covers every question');
        f.done('success');
      });
      for (let run = 0; run < 2; run++) {
        const result = await executeAuthoredFlow(handle, client, undefined, { rootRunId: 'root-sorted' });
        expect(result.completionReason).toBe('success');
      }
    } finally {
      client.close();
    }
    expect(stream).toHaveLength(1);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe(commands[0]);
    expect(commands[0]).toContain('{"gate":"predicate","step":"run-1","verdict":"pass","because":"plan covers every question"}');
  });
});
