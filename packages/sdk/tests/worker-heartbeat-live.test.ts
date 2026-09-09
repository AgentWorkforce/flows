import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { toKernelSpec } from '../src/compile.js';
import { JournalClient } from '../src/journal-client.js';
import { AgentWorker } from '../src/worker.js';

// Opt-in: uses the existing binary, never builds another kernel. The fake-clock
// sibling covers ten-minute steps and lifecycle races without a CI timing cost.
it.skipIf(!process.env['RELAYFLOWD_BIN'])('journals success after a real CLI runs beyond the 30-second lease', async () => {
  const directory = mkdtempSync('/tmp/rf-hb-');
  const cli = join(directory, 'slow-agent');
  writeFileSync(cli, `#!/usr/bin/env node
process.stdout.write('relayflows-agent-cli-v1\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('relayflows-agent-cli-v1-execute\\n');
  setTimeout(() => process.stdout.write('DONE'), 34_000);
});
`, { mode: 0o755 });
  const daemon = spawn(process.env['RELAYFLOWD_BIN']!, ['--data-dir', directory, 'serve'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  daemon.stderr.on('data', chunk => { stderr += String(chunk); });
  const socket = join(directory, 'relayflowd.sock');
  const client = new JournalClient(socket, { requestTimeoutMs: 5_000 });
  const worker = new AgentWorker(client, { workerId: 'heartbeat-live', pins: { workspace: [{ surface: 'repo', revision_id: 'rev-a' }], streams: [] } });
  const errors: unknown[] = [];
  worker.on('error', error => errors.push(error));
  const heartbeat = vi.spyOn(client, 'stepHeartbeat');
  const completion = vi.spyOn(client, 'stepComplete');
  try {
    await vi.waitFor(() => {
      if (daemon.exitCode !== null) throw new Error(stderr);
      expect(existsSync(socket)).toBe(true);
    }, { timeout: 5_000 });
    await client.connect();
    await client.hello('heartbeat-live');
    await worker.attach();
    const started = await client.runStart(toKernelSpec({
      version: '0.1.0', steps: [{ id: 'slow', type: 'agent', cli, instruction: 'work' }],
    }));
    // Observe completion, not elapsed wall time. The fixture supplies the
    // duration; counters and the durable journal are the assertions.
    await vi.waitFor(() => expect(completion).toHaveBeenCalled(), { timeout: 60_000, interval: 100 });
    await worker.close();
    const journal = (await client.journalRead(started.run_id, 1)).entries;
    const terminal = journal.find(entry => (entry as { entry_type: string }).entry_type === 'run.completed');
    console.log(JSON.stringify({ renewals: heartbeat.mock.calls.length, terminal, errors: errors.map(String) }));
    expect(errors).toEqual([]);
    expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(completion).toHaveBeenCalledTimes(1);
    expect(completion.mock.calls[0]).toMatchObject({ 2: 1, 4: 'success', 5: { output: { stdout_tail: 'DONE' } } });
    expect(terminal).toMatchObject({ payload: { completionReason: 'success' } });
    expect((await client.runGet(started.run_id)).steps['slow']).toMatchObject({ state: 'done' });
  } finally {
    await worker.close();
    client.close();
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const exited = once(daemon, 'exit');
      daemon.kill('SIGTERM');
      await exited;
    }
    heartbeat.mockRestore();
    completion.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
}, 75_000);
