import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AgentWorker } from '../src/worker.js';
import { openSidechannel } from '../src/pty-sidechannel.js';
import { runAgentCli } from '../src/worker-cli.js';
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

it.each(['none', 'view', 'passthrough', 'incomplete'])('%s subscriber lets an unattended CLI read EOF', async mode => {
  const dataDir = dir();
  const cli = join(dataDir, 'claude');
  writeFileSync(cli, `#!/usr/bin/env node
const watchdog = setTimeout(() => process.exit(91), 2000);
process.stdin.resume();
process.stdin.on('end', () => { clearTimeout(watchdog); process.stdout.write('eof'); });
`, { mode: 0o755 });
  let peer: Socket | undefined;
  let driven = false;
  try {
    const result = await runAgentCli(cli, 'test', undefined, undefined, undefined, undefined, 'agent', {
      dataDir, runId: 'r', stepId: 's', onDrive: () => { driven = true; },
      onReady(path) {
        if (mode === 'none') return;
        peer = connect(path, () => peer!.write(mode === 'incomplete' ? 'HELLO dri' : `HELLO ${mode}\n`));
      },
    });
    expect(result.exit_code).toBe(0);
    expect(result.stdout_tail).toBe('eof');
    expect(driven).toBe(false);
  } finally { peer?.destroy(); }
});

it('rejects drive after EOF without marking human intervention', async () => {
  const dataDir = dir();
  const cli = join(dataDir, 'claude');
  writeFileSync(cli, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('eof');
  setTimeout(() => process.exit(0), 300);
});
`, { mode: 0o755 });
  let peer: Socket | undefined;
  let driven = false;
  let attempted = false;
  let rejectedBeforeExit = false;
  try {
    const result = await runAgentCli(cli, 'test', undefined, undefined, undefined, undefined, 'agent', {
      dataDir, runId: 'r', stepId: 's', onDrive: () => { driven = true; },
      onReady(path) {
        peer = connect(path, () => peer!.write('HELLO view\n'));
        peer.once('data', () => {
          attempted = true;
          const late = connect(path, () => late.write('HELLO drive\nignored'));
          late.once('close', () => { rejectedBeforeExit = true; });
        });
      },
    });
    expect(result.exit_code).toBe(0);
    expect(attempted).toBe(true);
    expect(rejectedBeforeExit).toBe(true);
    expect(driven).toBe(false);
  } finally { peer?.destroy(); }
});

it('delivers all drive bytes in order across child stdin backpressure', async () => {
  const dataDir = dir();
  const cli = join(dataDir, 'claude');
  // Several pipe buffers, with distinct content to catch loss or retries.
  const payload = Buffer.concat(Array.from({ length: 64 }, (_, i) => Buffer.alloc(64 * 1024, i)));
  const digest = createHash('sha256').update(payload).digest('hex');
  writeFileSync(cli, `#!/usr/bin/env node
const hash = require('node:crypto').createHash('sha256');
let count = 0;
setTimeout(() => {
  process.stdin.on('data', bytes => {
    hash.update(bytes);
    count += bytes.length;
    if (count >= ${payload.length}) {
      process.stdout.write(count + ':' + hash.digest('hex'));
      process.exit(0);
    }
  });
}, 250);
`, { mode: 0o755 });
  let peer: Socket | undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const result = await runAgentCli(cli, 'test', undefined, undefined, undefined, controller.signal, 'agent', {
      dataDir, runId: 'r', stepId: 's', onDrive() {},
      onReady(path) {
        peer = connect(path, () => { peer!.write('HELLO drive\n'); peer!.write(payload); });
        peer.on('error', () => {});
        peer.resume();
      },
    });
    expect(result.exit_code).toBe(0);
    expect(result.stdout_tail).toBe(`${payload.length}:${digest}`);
  } finally { clearTimeout(timeout); peer?.destroy(); }
});
