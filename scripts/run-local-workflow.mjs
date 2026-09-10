#!/usr/bin/env node
// A local cell for one YAML/JSON run. No cloud admission or sandbox provider.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

async function main() {
  const [path, ...extra] = process.argv.slice(2);
  if (!path || extra.length) throw new Error('Usage: node scripts/run-local-workflow.mjs <flow.yaml|spec.json>');
  await access('packages/sdk/dist/cli.js').catch(() => {
    throw new Error('LOCAL_SDK_MISSING: build packages/sdk first (see ops/RUNTIME-STATUS.md).');
  });
  const { checkFlow } = await import('../packages/sdk/dist/cli/check.js');
  const { classifyOutcome } = await import('../packages/sdk/dist/cli/run.js');
  const { toKernelSpec } = await import('../packages/sdk/dist/compile.js');
  const { JournalClient } = await import('../packages/sdk/dist/journal-client.js');
  const { socketPathFor } = await import('../packages/sdk/dist/daemon-connection.js');
  const { AgentWorker } = await import('../packages/sdk/dist/worker.js');
  const checked = checkFlow(path);
  for (const diagnostic of checked.report.diagnostics) console.error(JSON.stringify(diagnostic));
  if (!checked.report.ok) return 2;
  const spec = toKernelSpec(checked.flow);
  const streams = new Set();
  // This launcher has no mount revision manager or LLM worker. Refuse before
  // creating a run rather than inventing pins or leaving an unserviceable step.
  for (const step of spec.steps) {
    if (step.type === 'llm') throw new Error(`LOCAL_LLM_WORKER_UNAVAILABLE: ${step.id}`);
    if (step.type === 'agent') {
      if (step.surfaces?.workspace?.length || step.surfaces?.external?.length) {
        throw new Error(`LOCAL_SURFACE_PINS_UNAVAILABLE: ${step.id}`);
      }
      for (const { stream } of step.surfaces?.streams ?? []) streams.add(stream);
    }
  }
  if (spec.steps.some(step => step.type === 'agent') && streams.size === 0) {
    throw new Error('LOCAL_AGENT_PINS_REQUIRED: declare a stream; the kernel refuses workers with no pins.');
  }
  const binary = resolve(process.env.RELAYFLOWD_BIN ?? 'kernel/target/debug/relayflowd');
  await access(binary, constants.X_OK).catch(() => {
    throw new Error(`LOCAL_DAEMON_MISSING: ${binary}; build kernel or set RELAYFLOWD_BIN.`);
  });
  await mkdir('.relayflow', { recursive: true });
  const dataDir = await mkdtemp(join(root, '.relayflow', 'local-'));
  const socket = socketPathFor(dataDir);
  if (Buffer.byteLength(socket) >= 104) throw new Error(`LOCAL_SOCKET_PATH_TOO_LONG: ${socket}`);
  console.log(`LOCAL_DATA_DIR=${dataDir}`);
  const daemon = spawn(binary, ['--data-dir', dataDir, 'serve'], { stdio: ['ignore', 'ignore', 'inherit'] });
  let daemonError;
  daemon.on('error', error => { daemonError = error; });
  const exited = once(daemon, 'close');
  // Keep rejections observed even if startup fails before shutdown awaits it.
  exited.catch(() => {});
  const client = new JournalClient(socket);
  let workerClient;
  let worker;
  let workerError;
  try {
    let connected = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (daemonError) throw daemonError;
      if (daemon.exitCode !== null) throw new Error(`LOCAL_DAEMON_EXITED: ${daemon.exitCode}`);
      try { await client.connect(); connected = true; break; }
      catch { client.close(); await delay(50); }
    }
    if (!connected) throw new Error('LOCAL_DAEMON_START_TIMEOUT: no socket after 5 seconds');
    await client.hello('local-workflow');
    if (spec.steps.some(step => step.type === 'agent')) {
      // The daemon serves requests serially per connection. step.complete
      // drives downstream commands before replying; status reads must not
      // queue behind that potentially long execution.
      workerClient = new JournalClient(socket);
      await workerClient.connect();
      await workerClient.hello('local-workflow-worker');
      worker = new AgentWorker(workerClient, {
        workerId: 'local-agent', capacity: 1,
        // Every run uses a fresh cell: its declared streams start at offset 0.
        // No worktree revision or recovery ability is claimed by these pins.
        pins: { workspace: [], streams: [...streams].map(stream => ({ stream, read_offset: 0 })) },
      });
      worker.on('error', error => { workerError ??= error; client.close(); });
      await worker.attach();
    }
    const outcome = await client.runStart(spec);
    const execution = await classifyOutcome(client, 'run', outcome, checked.report, socket, {});
    // A terminal snapshot can precede the completion acknowledgement. Drain
    // it before publishing success, while both connections are still open.
    await worker?.close();
    if (workerError) throw workerError;
    const entries = [];
    let from = 0;
    for (;;) {
      const page = await client.journalRead(outcome.run_id, from, 100);
      if (page.entries.length === 0) break;
      entries.push(...page.entries);
      from = page.entries.at(-1).seq + 1;
    }
    const journalPath = join(dataDir, 'journal.jsonl');
    await writeFile(journalPath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    for (const entry of entries) console.log(JSON.stringify(entry));
    console.log(`LOCAL_JOURNAL=${journalPath}`);
    console.log(JSON.stringify(execution.report));
    return execution.exitCode;
  } catch (error) {
    // Closing the control client interrupts a pending request on worker
    // failure. Keep the cause instead of reporting "closed by caller".
    throw workerError ?? error;
  } finally {
    await worker?.close();
    workerClient?.close();
    client.close();
    daemon.kill('SIGTERM');
    const forced = setTimeout(() => daemon.kill('SIGKILL'), 1000);
    try {
      await exited;
      await rm(socket, { force: true });
    } finally { clearTimeout(forced); }
  }
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
