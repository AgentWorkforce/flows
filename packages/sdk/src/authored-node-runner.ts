import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';
import type { AuthoredRootMetadata } from './authored-root.js';
import type { AuthoredExecutionRuntime, AuthoredFlowExecutionResult, ExecuteAuthoredFlowOptions } from './authored-flow-executor.js';
import { AuthoredFlowExecutionError, type AuthoredFlowExecutionErrorCode } from './authored-flow-error.js';
import { assertAuthoredPromiseHooks } from './authored-runtime-capability.js';

let embeddedSource: string | undefined;
/** Installed by the standalone build; never fetched or resolved from a workspace. */
export function installAuthoredNodeSource(source: string): void {
  if (embeddedSource !== undefined || source.length === 0) throw new Error('invalid authored runtime payload');
  embeddedSource = source;
}
const hash = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
const refusal = (): AuthoredFlowExecutionError => new AuthoredFlowExecutionError(
  'unsupported_promise_lifecycle',
  'authored execution requires the embedded Node runner and Node >=22.14 on PATH (or an absolute FLOWS_AUTHORED_NODE); no workflow body was executed',
);
interface NodeAuthority { path: string; version: string; executableSha256: string }
function nodeAuthority(): NodeAuthority {
  if (embeddedSource === undefined) throw refusal();
  const override = process.env['FLOWS_AUTHORED_NODE'];
  if (override !== undefined && !isAbsolute(override)) throw refusal();
  const probe = spawnSync(override ?? 'node', ['--input-type=module', '--eval', `
import {createHook} from 'node:async_hooks';
const [major,minor]=process.versions.node.split('.').map(Number);
let init=false,resolve=false;
const h=createHook({init(_id,type){if(type==='PROMISE')init=true},promiseResolve(){resolve=true}}).enable();
new Promise(r=>r());h.disable();
if(process.versions.bun || major<22 || (major===22 && minor<14) || !init || !resolve) process.exit(2);
process.stdout.write(JSON.stringify({path:process.execPath,version:process.versions.node}));
`], { encoding: 'utf8', timeout: 10_000, maxBuffer: 4096, env: process.env });
  if (probe.error || probe.status !== 0) throw refusal();
  try {
    const value = JSON.parse(probe.stdout) as { path: string; version: string };
    if (!isAbsolute(value.path) || !/^\d+\.\d+\.\d+$/.test(value.version)) throw refusal();
    const [major, minor] = value.version.split('.').map(Number);
    if (major! < 22 || (major === 22 && minor! < 14)) throw refusal();
    const path = realpathSync(value.path);
    return { path, version: value.version, executableSha256: hash(readFileSync(path)) };
  } catch { throw refusal(); }
}

/** Called before root admission/resume; declarative commands never reach it. */
export function assertAuthoredRuntimeAvailable(): void {
  if (process.versions['bun'] === undefined) assertAuthoredPromiseHooks();
  else nodeAuthority();
}

/** Bun retains the root lease and local workers. Only the authored body uses Node. */
export async function runAuthoredInNode(
  metadata: AuthoredRootMetadata,
  socketPath: string,
  rootRunId: string,
  options: ExecuteAuthoredFlowOptions,
): Promise<AuthoredFlowExecutionResult> {
  const authority = nodeAuthority();
  const source = embeddedSource!;
  const runtime: AuthoredExecutionRuntime = {
    kind: 'node', version: authority.version,
    executableSha256: authority.executableSha256, payloadSha256: hash(source),
  };
  options.signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'flows-authored-node-'));
  const entry = join(directory, 'runner.mjs');
  try {
    await writeFile(entry, source, { mode: 0o400, flag: 'wx' });
    if (hash(await readFile(entry)) !== runtime.payloadSha256) throw refusal();
    const child = spawn(authority.path, ['--experimental-transform-types', entry], {
      cwd: process.cwd(), env: process.env,
      stdio: ['pipe', 'inherit', 'inherit', 'pipe'],
    });
    return await new Promise<AuthoredFlowExecutionResult>((resolve, reject) => {
      let buffer = '', ready = false, result: AuthoredFlowExecutionResult | undefined;
      let failure: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (error: Error): void => {
        failure ??= error;
        child.kill('SIGTERM');
        killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2500);
        killTimer.unref();
      };
      const abort = (): void => stop(new Error('authored root execution was aborted'));
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      // Do not intercept the parent's signals: its normal exit keeps the root
      // recoverable. The child observes parent EOF (and shared process-group signals).
      const startupTimer = setTimeout(() => stop(new Error('authored runtime readiness timed out')), 10_000);
      startupTimer.unref();
      const pipe = child.stdio[3] as Readable;
      pipe.setEncoding('utf8');
      pipe.on('data', (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { stop(new Error('authored runtime response exceeded limit')); return; }
        for (;;) {
          const end = buffer.indexOf('\n'); if (end < 0) break;
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const message = JSON.parse(line);
            if (message.type === 'ready' && !ready && !result) {
              if (JSON.stringify(message.runtime) !== JSON.stringify(runtime)) throw refusal();
              ready = true;
              clearTimeout(startupTimer);
              // Keep stdin open: EOF tells the child its lease-owning parent died.
              child.stdin!.write(JSON.stringify({ metadata, socketPath, rootRunId,
                dataDir: options.dataDir, localAgentStream: options.localAgentStream }) + '\n');
            } else if (!ready || result) throw new Error('unexpected authored runtime message');
            else if (message.type === 'progress') options.onProgress?.(message.event);
            else if (message.type === 'wait') options.onWait?.(message.event);
            else if (message.type === 'result') result = { ...message.result, executionRuntime: runtime };
            else if (message.type === 'error') {
              failure = typeof message.code === 'string'
                ? new AuthoredFlowExecutionError(message.code as AuthoredFlowExecutionErrorCode,
                  message.message, message.completionReason, message.runId)
                : new Error(message.message);
            } else throw new Error('unknown authored runtime message');
          } catch (error) { stop(error instanceof Error ? error : new Error('invalid authored runtime message')); }
        }
      });
      child.stdin!.on('error', () => stop(new Error('authored runtime request pipe closed')));
      pipe.on('error', () => stop(new Error('authored runtime result pipe failed')));
      child.once('error', () => { failure = refusal(); });
      child.once('close', (code) => {
        clearTimeout(startupTimer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        options.signal?.removeEventListener('abort', abort);
        if (failure) reject(failure);
        else if (code !== 0 || !ready || result === undefined || buffer.length > 0) reject(new Error('authored runtime exited without a complete result'));
        else resolve(result);
      });
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
