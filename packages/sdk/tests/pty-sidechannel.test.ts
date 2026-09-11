import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AgentWorker } from '../src/worker.js';
import { openSidechannel } from '../src/pty-sidechannel.js';
import type { JournalClient } from '../src/journal-client.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function dir() { const path = mkdtempSync('/tmp/q-'); dirs.push(path); return path; }

it.each(['view', 'drive', 'passthrough', 'none'])('%s attach preserves worker completion and marks only drive', async mode => {
  const dataDir = dir();
  const cli = join(dataDir, 'claude');
  writeFileSync(cli, `#!/usr/bin/env node
process.stdin.on('data', b => { process.stdout.write('injected:' + b); process.exit(0); });
setTimeout(() => process.stdout.write('visible\\n'), 150);
setTimeout(() => process.exit(0), 450);
`, { mode: 0o755 });
  const client = new EventEmitter() as EventEmitter & { workerAttach: () => Promise<void>; stepComplete: (...args: unknown[]) => Promise<void>; stepHeartbeat: () => Promise<{ lease_deadline_ms: number }> };
  client.workerAttach = async () => {};
  client.stepHeartbeat = async () => ({ lease_deadline_ms: Date.now() + 60_000 });
  let finish!: (args: unknown[]) => void;
  const done = new Promise<unknown[]>(resolve => { finish = resolve; });
  client.stepComplete = async (...args) => { finish(args); };
  let socket: Socket | undefined;
  let received = '';
  let socketPath = '';
  const worker = new AgentWorker(client as unknown as JournalClient, {
    workerId: 'test', pins: { workspace: [], streams: [] }, dataDir,
    onPtyReady(path) {
      socketPath = path;
      if (mode === 'none') return;
      socket = connect(path, () => {
        socket!.write('HEL');
        socket!.write(`LO ${mode}\n${mode === 'drive' ? 'operator\n' : 'ignored\n'}`);
      });
      socket.on('data', bytes => { received += bytes.toString(); });
    },
  });
  worker.on('error', error => { throw error; });
  await worker.attach();
  client.emit('step.dispatch', {
    run_id: 'r', step_id: 's', step_type: 'agent', attempt: 1,
    idempotency_key: 'k', lease_id: 'lease', lease_deadline_ms: Date.now() + 60_000,
    pins: { workspace: [], streams: [] }, spec: { cli, instruction: 'test' },
  });
  try {
    const args = await done;
    expect(args[4]).toBe('success');
    const completion = args[5] as { human_intervention?: boolean; output: { stdout_tail: string } };
    expect(completion.human_intervention).toBe(mode === 'drive' ? true : undefined);
    expect(completion.output.stdout_tail).toContain(mode === 'drive' ? 'injected:operator' : 'visible');
    if (mode !== 'none' && mode !== 'drive') expect(received).toContain('visible');
    expect(existsSync(socketPath)).toBe(false);
  } finally { socket?.destroy(); await worker.close(); }
});

it('broken handshake and occupied socket do not affect the sidechannel owner', async () => {
  const context = { dataDir: dir(), runId: 'r', stepId: 's', onDrive: () => { throw new Error('must not drive'); } };
  let path = '';
  const first = await openSidechannel({ ...context, onReady: value => { path = value; } }, () => true);
  expect(first).toBeDefined();
  try {
    expect(await openSidechannel(context, () => true)).toBeUndefined();
    const peer = connect(path);
    await new Promise<void>(resolve => { peer.once('close', () => resolve()); peer.write('garbage\n'); });
    expect(existsSync(path)).toBe(true);
  } finally { first?.close(); }
});
