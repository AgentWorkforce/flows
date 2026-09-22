import { Worker } from 'node:worker_threads';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, writeSync } from 'node:fs';
import { JournalClient } from './journal-client.js';
import { executeAuthoredFlow } from './authored-flow-executor.js';
import { loadPinnedAuthoredSource } from './authored-source-authority.js';
import { assertAuthoredNodeVersion, parseAuthoredParentPid } from './authored-runtime-capability.js';
import { AuthoredFlowExecutionError, AuthoredHumanParked } from './authored-flow-error.js';
import { isAgentCapacity } from './worker-slots.js';
import type { AuthoredRootMetadata } from './authored-root.js';

let channelKey: string | undefined, sequence = 0;
// Capture writers before loading authored modules; credentials never enter env.
const writeFrame = writeSync, mac = createHmac;
const send = (message: unknown): void => {
  const payload = JSON.stringify(message);
  if (channelKey === undefined) { writeFrame(3, payload + '\n'); return; }
  const seq = ++sequence;
  writeFrame(3, JSON.stringify({ seq, payload,
    mac: mac('sha256', channelKey).update(`${seq}\0${payload}`).digest('hex') }) + '\n');
};
const hash = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const controller = new AbortController();
let finished = false;
const abort = (): void => {
  controller.abort();
  setTimeout(() => process.exit(1), 2000).unref();
};
process.on('SIGINT', abort); process.on('SIGTERM', abort);
// The parent owns the root lease. Do not continue authored effects after it dies.
process.stdin.on('end', () => { if (!finished) process.exit(1); });
process.stdin.on('error', () => process.exit(1));
// A separate event loop enforces parent loss even while authored JS is blocked.
// Capture the expected PID in the parent's spawn arguments, before any child work.
const parentPid = parseAuthoredParentPid(process.argv[2]);
const watchdog = new Worker(`
  const {parentPort,workerData}=require('node:worker_threads');
  function check(){if(process.ppid!==workerData.parentPid)process.kill(process.pid,'SIGKILL');}
  check();setInterval(check,50);parentPort.postMessage('ready');
`, { eval: true, workerData: { parentPid } });
// Enforcement must not silently disappear after the readiness Promise settles.
const watchdogLost = (): void => { if (!finished) process.kill(process.pid, 'SIGKILL'); };
watchdog.on('error', watchdogLost);
watchdog.on('exit', watchdogLost);
let client: JournalClient | undefined;
try {
  assertAuthoredNodeVersion();
  await new Promise<void>((resolve,reject)=>{watchdog.once('message',()=>resolve());watchdog.once('error',reject);});
  send({ type: 'ready', runtime: { kind: 'node', version: process.versions.node,
    executableSha256: hash(process.execPath), payloadSha256: hash(process.argv[1]!) } });
  const request = await new Promise<{ channelKey: string; metadata: AuthoredRootMetadata; socketPath: string;
    rootRunId: string; dataDir: string; localAgentStream?: string; workerCapacity?: number }>((resolve, reject) => {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    const onData = (chunk: string): void => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { reject(new Error('authored runtime request exceeded limit')); return; }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      process.stdin.off('data', onData);
      try { resolve(JSON.parse(buffer.slice(0, end))); } catch { reject(new Error('invalid authored runtime request')); }
    };
    process.stdin.on('data', onData);
  });
  if (typeof request.channelKey !== 'string' || !/^[a-f0-9]{64}$/.test(request.channelKey)) throw new Error('invalid authored channel key');
  channelKey = request.channelKey;
  controller.signal.throwIfAborted();
  const loaded = await loadPinnedAuthoredSource(request.metadata, true);
  if (request.localAgentStream !== request.metadata.localAgentStream) throw new Error('authored root local agent surface mismatch');
  if (request.workerCapacity !== undefined && !isAgentCapacity(request.workerCapacity)) throw new Error('invalid authored worker capacity');
  client = new JournalClient(request.socketPath);
  await client.connect(); await client.hello('flows-authored-node');
  const result = await executeAuthoredFlow(loaded.handle, client,
    request.metadata.inputPresent ? request.metadata.input : undefined, {
      getDefinition: loaded.getDefinition, dataDir: request.dataDir,
      flowPath: request.metadata.flowPath, rootRunId: request.rootRunId,
      extensions: loaded.extensions,
      localAgentStream: request.localAgentStream, signal: controller.signal,
      ...(request.workerCapacity === undefined ? {} : { workerCapacity: request.workerCapacity }),
      onProgress: event => send({ type: 'progress', event }),
      onWait: event => send({ type: 'wait', event }),
    });
  send({ type: 'result', result });
} catch (error) {
  const message = error instanceof Error ? error.message : 'authored body failed';
  const prefix = error instanceof AuthoredFlowExecutionError ? `${error.code}: ` : '';
  send({ type: 'error', message: prefix && message.startsWith(prefix) ? message.slice(prefix.length) : message,
    // `details` is the failing child step's journal evidence. Without it the
    // parent can only re-render the message, and the machine-readable
    // diagnostic loses the command's exit code and output tails.
    ...(error instanceof AuthoredFlowExecutionError ? { code: error.code,
      completionReason: error.completionReason, runId: error.runId,
      details: error.details } : {}),
    ...(error instanceof AuthoredHumanParked ? { wait: error.wait } : {}) });
  process.exitCode = 1;
} finally {
  finished = true; await watchdog.terminate(); client?.close(); process.stdin.destroy();
  process.off('SIGINT', abort); process.off('SIGTERM', abort);
}
