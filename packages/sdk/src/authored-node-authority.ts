import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants as fsConstants, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';

export const authoredNodeRefusal = (): AuthoredFlowExecutionError => new AuthoredFlowExecutionError(
  'unsupported_promise_lifecycle',
  'authored execution requires the embedded Node runner and Node >=22.14 on PATH (or an absolute FLOWS_AUTHORED_NODE); no workflow body was executed',
);
export interface NodeAuthority { path: string; version: string; executableSha256: string }

const PROBE_ARGS = ['--input-type=module', '--eval', `
import {createHook} from 'node:async_hooks';
import {stripTypeScriptTypes,register} from 'node:module';
const [major,minor]=process.versions.node.split('.').map(Number);
let init=false,resolve=false;
const h=createHook({init(_id,type){if(type==='PROMISE')init=true},promiseResolve(){resolve=true}}).enable();
new Promise(r=>r());h.disable();
if(process.versions.bun || major<22 || (major===22 && minor<14) || !init || !resolve || typeof stripTypeScriptTypes!=='function' || typeof register!=='function') process.exit(2);
process.stdout.write(JSON.stringify({path:process.execPath,version:process.versions.node}));
`];
const PROBE_TIMEOUT_MS = 10_000, PROBE_MAX_BYTES = 4096;

/**
 * One authored run asks for the Node authority before root admission and
 * again before spawning the body. Each probe spawns Node and hashes its whole
 * executable (~100 MB), which a cold sandbox pays on the startup path twice.
 * Reuse the previous answer only while the same candidate is selected (the
 * override or the first `node` on PATH, by path and by realpath, so a
 * retargeted symlink re-probes) and the executable it resolved is unchanged.
 * The spawned child still hashes the executable it actually runs and the
 * parent compares that report with this authority, so a binary replaced
 * after the probe is refused, never trusted.
 */
let probedAuthority: { selection: string; fingerprint: string; authority: NodeAuthority } | undefined;
function executableFingerprint(path: string): string {
  const stat = statSync(path, { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}
/** The candidate `spawnSync(override ?? 'node')` would run, by path and realpath. */
function selectedCandidate(override: string | undefined): string | undefined {
  const directories = (process.env['PATH'] ?? '').split(delimiter);
  // A relative PATH entry resolves against the working directory; do not
  // guess which candidate the spawn would pick, just probe every time.
  if (override === undefined && directories.some(directory => !isAbsolute(directory))) return undefined;
  const candidates = override !== undefined ? [override] : directories.map(directory => join(directory, 'node'));
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return `${candidate}\0${realpathSync(candidate)}`;
    } catch { /* Not this candidate. */ }
  }
  return undefined;
}

type Probe = { readonly command: string; readonly selection: string | undefined };
/** The remembered authority while it is still valid, otherwise what to probe. */
function rememberedOrProbe(): NodeAuthority | Probe {
  const override = process.env['FLOWS_AUTHORED_NODE'];
  if (override !== undefined && !isAbsolute(override)) throw authoredNodeRefusal();
  const selection = selectedCandidate(override);
  if (selection !== undefined && probedAuthority?.selection === selection) {
    try {
      if (executableFingerprint(probedAuthority.authority.path) === probedAuthority.fingerprint) {
        return probedAuthority.authority;
      }
    } catch { /* A vanished executable is re-probed, and refused there. */ }
  }
  probedAuthority = undefined;
  return { command: override ?? 'node', selection };
}

/** The probed Node's real path, before its bytes are hashed. */
function probedNode(stdout: string): { path: string; version: string; fingerprint: string } {
  const value = JSON.parse(stdout) as { path: string; version: string };
  if (!isAbsolute(value.path) || !/^\d+\.\d+\.\d+$/.test(value.version)) throw authoredNodeRefusal();
  const [major, minor] = value.version.split('.').map(Number);
  if (major! < 22 || (major === 22 && minor! < 14)) throw authoredNodeRefusal();
  const path = realpathSync(value.path);
  return { path, version: value.version, fingerprint: executableFingerprint(path) };
}

function remember(selection: string | undefined, fingerprint: string, authority: NodeAuthority): NodeAuthority {
  // Reuse only an answer for a candidate that could be identified, and not
  // one whose file was rewritten while it was being hashed.
  if (selection !== undefined && executableFingerprint(authority.path) === fingerprint) {
    probedAuthority = { selection, fingerprint, authority };
  }
  return authority;
}

export function nodeAuthority(): NodeAuthority {
  const request = rememberedOrProbe();
  if (!('command' in request)) return request;
  const probe = spawnSync(request.command, PROBE_ARGS, {
    encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BYTES, env: process.env,
  });
  if (probe.error || probe.status !== 0) throw authoredNodeRefusal();
  try {
    const { path, version, fingerprint } = probedNode(probe.stdout);
    const executableSha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
    return remember(request.selection, fingerprint, { path, version, executableSha256 });
  } catch { throw authoredNodeRefusal(); }
}

/**
 * The CLI loads the flow (importing it and hashing its Surface package)
 * before it first asks for the Node authority. A prewarm runs the same probe
 * concurrently with that load, hashes the executable on a worker thread so
 * the load keeps the main thread, and only fills the memo above under the
 * same rules. It never answers by itself: {@link awaitNodeAuthority} still
 * validates the memo, and a failed, stopped or unusable prewarm leaves the
 * probe and its refusal to that call.
 */
let prewarm: { readonly done: Promise<void>; readonly stop: AbortController } | undefined;
export function prewarmNodeAuthority(): void {
  if (prewarm !== undefined) return;
  const stop = new AbortController();
  prewarm = { stop, done: probeInBackground(stop.signal).catch(() => { /* A miss: the next call probes, and refuses, itself. */ }) };
}

/** Stop a prewarm that is still running, so a run that ends early does not wait for it. */
export async function stopNodeAuthorityPrewarm(): Promise<void> {
  prewarm?.stop.abort();
  await prewarm?.done;
}

export async function awaitNodeAuthority(): Promise<NodeAuthority> {
  await prewarm?.done;
  return nodeAuthority();
}

async function probeInBackground(signal: AbortSignal): Promise<void> {
  const request = rememberedOrProbe();
  // Nothing a later call could reuse: an unidentifiable candidate is never remembered.
  if (!('command' in request) || request.selection === undefined) return;
  const { path, version, fingerprint } = probedNode(await probeOutput(request.command, signal));
  remember(request.selection, fingerprint, { path, version, executableSha256: await fileSha256(path, signal) });
}

/**
 * `spawnSync`'s contract above, without blocking: exit 0 within the time
 * limit, and at most PROBE_MAX_BYTES on stdout and on stderr (spawnSync's
 * maxBuffer bounds each stream).
 */
function probeOutput(command: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('node probe stopped')); return; }
    const child = spawn(command, PROBE_ARGS, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const bytes = { stdout: 0, stderr: 0 };
    let settled = false;
    const finish = (error: Error | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', stopped);
      if (error === undefined) { resolve(Buffer.concat(stdout).toString('utf8')); return; }
      // A grandchild may hold the pipes open; close this side so nothing waits on them.
      child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy();
      reject(error);
    };
    const stopped = (): void => finish(new Error('node probe stopped'));
    const timer = setTimeout(() => finish(new Error('node probe timed out')), PROBE_TIMEOUT_MS);
    signal.addEventListener('abort', stopped, { once: true });
    const bounded = (stream: 'stdout' | 'stderr') => (chunk: Buffer): void => {
      bytes[stream] += chunk.length;
      if (bytes[stream] > PROBE_MAX_BYTES) finish(new Error(`node probe ${stream} exceeded limit`));
      else if (stream === 'stdout') stdout.push(chunk);
    };
    child.stdout.on('data', bounded('stdout'));
    child.stderr.on('data', bounded('stderr'));
    child.once('error', error => finish(error));
    child.once('close', code => finish(code === 0 ? undefined : new Error('node probe failed')));
  });
}

/** SHA-256 of a file, computed on a worker thread. */
const HASH_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
try { parentPort.postMessage({ sha256: createHash('sha256').update(readFileSync(workerData)).digest('hex') }); }
catch (error) { parentPort.postMessage({ error: String(error) }); }
`;
function fileSha256(path: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('node hash stopped')); return; }
    const worker = new Worker(HASH_WORKER, { eval: true, workerData: path });
    let settled = false;
    const finish = (error: Error | undefined, sha256?: string): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', stopped);
      void worker.terminate();
      if (error === undefined && sha256 !== undefined && /^[a-f0-9]{64}$/.test(sha256)) resolve(sha256);
      else reject(error ?? new Error('node hash failed'));
    };
    const stopped = (): void => finish(new Error('node hash stopped'));
    signal.addEventListener('abort', stopped, { once: true });
    worker.once('message', (message: { sha256?: string; error?: string }) =>
      finish(message.error === undefined ? undefined : new Error(message.error), message.sha256));
    worker.once('error', error => finish(error));
    worker.once('exit', () => finish(new Error('node hash worker exited')));
  });
}
