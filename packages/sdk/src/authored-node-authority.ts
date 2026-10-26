import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants as fsConstants, createReadStream, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
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
 * and hash concurrently with that load, without blocking it, and only fills
 * the memo above under the same rules. It never answers by itself:
 * {@link awaitNodeAuthority} still validates the memo, and a failed or
 * unusable prewarm leaves the probe and its refusal to that call.
 */
let prewarm: Promise<void> | undefined;
export function prewarmNodeAuthority(): void {
  prewarm ??= probeInBackground().catch(() => { /* A miss: the next call probes, and refuses, itself. */ });
}

export async function awaitNodeAuthority(): Promise<NodeAuthority> {
  await prewarm;
  return nodeAuthority();
}

async function probeInBackground(): Promise<void> {
  const request = rememberedOrProbe();
  // Nothing a later call could reuse: an unidentifiable candidate is never remembered.
  if (!('command' in request) || request.selection === undefined) return;
  const { path, version, fingerprint } = probedNode(await probeOutput(request.command));
  remember(request.selection, fingerprint, { path, version, executableSha256: await fileSha256(path) });
}

/** `spawnSync`'s contract above, without blocking: exit 0, bounded output and time. */
function probeOutput(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, PROBE_ARGS, { env: process.env, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    const fail = (error: Error): void => { child.kill('SIGKILL'); reject(error); };
    const timer = setTimeout(() => fail(new Error('node probe timed out')), PROBE_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > PROBE_MAX_BYTES) fail(new Error('node probe output exceeded limit'));
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout); else reject(new Error('node probe failed'));
    });
  });
}

async function fileSha256(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) digest.update(chunk as Buffer);
  return digest.digest('hex');
}
