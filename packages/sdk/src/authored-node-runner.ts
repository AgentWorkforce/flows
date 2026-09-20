import { JournalClient } from './journal-client.js';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';
import type { AuthoredRootMetadata } from './authored-root.js';
import type { AuthoredExecutionRuntime, AuthoredFlowExecutionResult, ExecuteAuthoredFlowOptions } from './authored-flow-executor.js';
import { completionMarker, isLoweredCompletion } from './authored-flow-executor.js';
import {
  AuthoredFlowExecutionError, AuthoredHumanParked,
  type AuthoredFlowExecutionErrorCode, type AuthoredHumanWait,
} from './authored-flow-error.js';
import { HUMAN_WAIT_ID } from './authored-human.js';
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
import {stripTypeScriptTypes,register} from 'node:module';
const [major,minor]=process.versions.node.split('.').map(Number);
let init=false,resolve=false;
const h=createHook({init(_id,type){if(type==='PROMISE')init=true},promiseResolve(){resolve=true}}).enable();
new Promise(r=>r());h.disable();
if(process.versions.bun || major<22 || (major===22 && minor<14) || !init || !resolve || typeof stripTypeScriptTypes!=='function' || typeof register!=='function') process.exit(2);
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
    const child = spawn(authority.path, ['--experimental-transform-types', entry, String(process.pid)], {
      cwd: process.cwd(), env: process.env,
      stdio: ['pipe', 'inherit', 'inherit', 'pipe'],
    });
    const result = await new Promise<AuthoredFlowExecutionResult>((resolve, reject) => {
      const channelKey = randomBytes(32).toString('hex');
      let expectedSequence = 1;
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
            let message = JSON.parse(line);
            if (ready) {
              if (message.seq !== expectedSequence || typeof message.payload !== 'string'
                || typeof message.mac !== 'string' || !/^[a-f0-9]{64}$/.test(message.mac)) {
                throw new Error('invalid authored runtime authenticated frame');
              }
              const expected = createHmac('sha256', channelKey)
                .update(`${expectedSequence}\0${message.payload}`).digest();
              if (!timingSafeEqual(expected, Buffer.from(message.mac, 'hex'))) {
                throw new Error('invalid authored runtime authenticated frame');
              }
              expectedSequence++;
              message = JSON.parse(message.payload);
            }
            if (message.type === 'ready' && !ready && !result) {
              if (JSON.stringify(message.runtime) !== JSON.stringify(runtime)) throw refusal();
              ready = true;
              clearTimeout(startupTimer);
              // Keep stdin open: EOF tells the child its lease-owning parent died.
              child.stdin!.write(JSON.stringify({ channelKey, metadata, socketPath, rootRunId,
                dataDir: options.dataDir, localAgentStream: options.localAgentStream }) + '\n');
            } else if (!ready || result) throw new Error('unexpected authored runtime message');
            else if (message.type === 'progress') options.onProgress?.(message.event);
            else if (message.type === 'wait') options.onWait?.(message.event);
            else if (message.type === 'result') result = { ...message.result, executionRuntime: runtime };
            else if (message.type === 'error') {
              failure = message.code === 'human_parked' && isHumanWaitFrame(message.wait) && message.runId === rootRunId
                ? new AuthoredHumanParked(message.wait, rootRunId)
                : typeof message.code === 'string'
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
    await verifyAuthoredNodeResult(result, metadata, rootRunId, socketPath);
    return result;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** A park signal from the child names the question the parent must journal. */
function isHumanWaitFrame(value: unknown): value is AuthoredHumanWait {
  const wait = value as Partial<AuthoredHumanWait> | null;
  return typeof wait === 'object' && wait !== null
    && typeof wait.waitId === 'string' && HUMAN_WAIT_ID.test(wait.waitId)
    && typeof wait.question === 'string' && wait.question !== ''
    && typeof wait.to === 'string' && wait.to !== '';
}

/** The IPC frame is a claim, not a durable terminal fact or a sandbox boundary. */
export async function verifyAuthoredNodeResult(
  result: AuthoredFlowExecutionResult, metadata: AuthoredRootMetadata,
  rootRunId: string, socketPath: string,
): Promise<void> {
  const invalid = (why = ''): never => { throw new Error(`authored runtime result has no matching durable completion${process.env['FLOWS_VERIFIER_DEBUG'] && why ? ` (${why})` : ''}`); };
  if (result.rootRunId !== rootRunId || result.name !== metadata.flowName
    || !isLoweredCompletion(result.completionReason)
    || !Array.isArray(result.journalSteps) || result.journalSteps.length === 0) invalid('frame');
  const terminal = result.journalSteps.at(-1)!;
  if (!terminal || !/^complete-[1-9][0-9]*$/.test(terminal.id)) invalid('terminal');
  const count = Number(terminal.id.slice('complete-'.length));
  // A predicate gate is journaled as `<step>.gate`: a child run subordinate
  // to the authored step it judges, in the same `<step>.gate` shape a named
  // gate lowers to inside its step's own spec. Neither consumes an ordinal —
  // `complete-N` counts the operations the author wrote (SURFACE.md §6) —
  // so gates are set aside from the count and the contiguity check, and
  // verified separately: every gate must name a claimed parent, and is then
  // held to the same durable-completion evidence as any other child run.
  const isGate = (id: string): boolean => /\.gate$/.test(id);
  const authored = result.journalSteps.filter(step => typeof step?.id === 'string' && !isGate(step.id));
  const gates = result.journalSteps.filter(step => typeof step?.id === 'string' && isGate(step.id));
  if (!Number.isSafeInteger(count) || authored.length !== count || isGate(terminal.id)) invalid(`count ${authored.length}!=${count}`);
  const ordinal = (id: string): number => Number(/-([1-9][0-9]*)$/.exec(id)?.[1]);
  // Parallel awaits may finish in either order; validate a copy in declaration order.
  const ordered = [...authored].sort((a,b)=>ordinal(a.id)-ordinal(b.id));
  const authoredIds = new Set(ordered.map(step => step.id));
  for (const gate of gates) {
    if (!authoredIds.has(gate.id.slice(0, -'.gate'.length))) invalid(`orphan ${gate.id}`);
  }
  const runs = new Set<string>();
  const journal = new JournalClient(socketPath);
  await journal.connect();
  try {
    await journal.hello('flows-authored-result-verifier');
    for (const [index, claimed] of [...ordered, ...gates].entries()) {
      if (!claimed || typeof claimed.id !== 'string' || typeof claimed.runId !== 'string'
        || (index < ordered.length && ordinal(claimed.id) !== index+1) || claimed.completionReason !== 'success'
        || runs.has(claimed.runId)) invalid(`claim ${claimed?.id}`);
      runs.add(claimed.runId);
      const state = await journal.runGet(claimed.runId);
      if (state.run_id !== claimed.runId || state.status !== 'completed'
        || state.steps[claimed.id]?.state !== 'done') invalid(`state ${claimed.id} ${state.status} ${state.steps[claimed.id]?.state}`);
      const entries: Array<{
        seq: number; entry_type: string; step_id?: string; payload?: {
          completionReason?: string; spec?: { name?: string; steps?: Array<{id?:string;type?:string;command?:string}> };
        };
      }> = [];
      let fromSeq = 1;
      for (;;) {
        const page = (await journal.journalRead(claimed.runId, fromSeq, 100)).entries;
        if (page.length === 0) break;
        for (const raw of page) {
          const entry = raw as typeof entries[number];
          if (!Number.isSafeInteger(entry?.seq) || entry.seq < fromSeq) invalid('seq');
          fromSeq = entry.seq + 1;
          // Keep only completion evidence; streaming logs can span many pages.
          if (['run.spawned', 'step.completed', 'run.completed'].includes(entry.entry_type)) entries.push(entry);
        }
      }
      const spec = entries.find(entry => entry.entry_type === 'run.spawned')?.payload?.spec;
      const step = spec?.steps?.[0];
      // A named gate lowers INTO the step's own spec as a second, dependent
      // `<id>.gate` step (named-gate-lowering.ts); that is the only other
      // step a child spec may carry, and it must have completed too.
      const lowered = spec?.steps ?? [];
      const specShape = lowered.length === 1 || (lowered.length === 2 && lowered[1]?.id === `${claimed.id}.gate`);
      const completed = entries.filter(entry => entry.entry_type === 'step.completed' && entry.step_id === claimed.id);
      const gateCompleted = lowered.length === 2
        ? entries.filter(entry => entry.entry_type === 'step.completed' && entry.step_id === `${claimed.id}.gate`) : [];
      const terminalFacts = entries.filter(entry => entry.entry_type === 'run.completed');
      if (spec?.name !== `${metadata.flowName}/${claimed.id}` || !specShape
        || step?.id !== claimed.id || completed.length !== 1
        || completed[0]?.payload?.completionReason !== 'success'
        || (lowered.length === 2 && (gateCompleted.length !== 1 || gateCompleted[0]?.payload?.completionReason !== 'success'))
        || terminalFacts.length !== 1 || terminalFacts[0]?.payload?.completionReason !== 'success') invalid(`evidence ${claimed.id} spec=${spec?.name} step=${step?.id} completed=${completed.length}`);
      if (claimed === terminal) {
        // The claimed verdict must match the marker the journal actually
        // recorded, so an IPC frame cannot claim `success` over a run whose
        // durable terminal says `step_failed` (or the reverse). The
        // `isLoweredCompletion` check at the top of this function already
        // rejected a frame whose reason is not lowerable at all — that one is
        // the runtime validation of untrusted IPC, and it is why nothing has
        // to be re-asserted here just to satisfy the type.
        if (step?.type !== 'deterministic'
          || step.command !== completionMarker(result.completionReason)) invalid('marker');
      }
    }
  } finally { journal.close(); }
}
