import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { diffWorkspaceFiles, snapshotWorkspaceFiles } from './agent-artifacts.js';
import { claudeResultOutcome, decodeProviderResult, decodeWrapperResult, requirePricedUsage } from './worker-usage.js';
import { openSidechannel, type SidechannelContext } from './pty-sidechannel.js';
import { openTranscriptWriter, transcriptPath, type TranscriptDigest, type TranscriptFile, type TranscriptWriter } from './agent-transcript.js';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { childStop } from './child-stop.js';
import { reapOnExit } from './agent-reaper.js';
import {
  agentExecution,
  llmExecution,
  cliAdapterKind,
  resolveCliModel,
  type CliInvocation,
  type CliAdapterKind,
} from './cli-adapter.js';
import {
  runWrapperSession,
  type WrapperSessionLimits,
} from './wrapper-session.js';
import { wrapperEnvironment } from './wrapper-runtime.js';
import { redactRelayError } from './redact.js';
import { applyStepEnvironment } from './step-env.js';
import { TAIL_CLOSE_TIMEOUT_MS, openTranscriptTail, transcriptTailPath, type TranscriptTailWriter } from './transcript-tail.js';
import {
  runAgentRelayTask,
  AgentRelayTransportError,
  type AgentTransport,
} from './agent-relay-transport.js';

/** Present only when a dispatched agent step carries a journaled wake context. */
export const WAKE_CONTEXT_ENV = 'RELAYFLOW_WAKE_CONTEXT';

/**
 * Private wrapper model variable name. Ambient values are scrubbed; a wrapper
 * may set it inside the already-identified process from the session request.
 * Raw Claude/Codex adapters receive provider-native model flags.
 */
export const MODEL_ENV = 'RELAYFLOW_MODEL';

export interface WorkerCliResult {
  relay_task?: import('./agent-relay-receipt.js').RelayTaskReceipt;
  tokens_input?: number;
  tokens_output?: number;
  exit_code: number | null;
  stdout_tail: string;
  stderr_tail: string;
  /**
   * Files the agent created or changed under its working directory,
   * cwd-relative POSIX paths, sorted. Measured by the worker that spawned the
   * CLI — the one process provably sharing the agent's filesystem — as a
   * content-hash diff of the directory before and after the run, so it is a
   * journaled fact rather than a later guess. Present for every direct agent
   * execution; absent for `llm` mode and for the relay transport, where the
   * agent runs on another host.
   */
  artifacts?: string[];
  /**
   * The attempt's transcript digest (`agent-transcript.ts`): provider result
   * metadata, tool calls summarized, final text, failure excerpt, and — when
   * the spawn had a sidechannel context with an attempt — the pointer to the
   * redacted, capped `stream-json` file. Journaled in `trajectory_tail`, never
   * in `output`. Present for Claude/Codex executions; absent for wrappers and
   * the relay transport, which stream no provider frames through this process.
   */
  transcript?: TranscriptDigest;
}

/**
 * Journal identity and durable dispatch storage used by the Relay task transport.
 */
export interface AgentRelayContext {
  runId: string;
  stepId: string;
  idempotencyKey: string;
  dataDir?: string;
  resultSchema?: unknown;
}

export async function runAgentCli(
  cli: string,
  instruction: string,
  wakeContext: unknown,
  model?: string,
  wrapperLimits?: Partial<WrapperSessionLimits>,
  signal?: AbortSignal,
  mode: 'agent' | 'llm' = 'agent',
  sidechannel?: SidechannelContext,
  cwd?: string,
  transport: AgentTransport = 'direct',
  relayContext?: AgentRelayContext,
): Promise<WorkerCliResult> {
  signal?.throwIfAborted();
  if (signal !== undefined && process.platform === 'win32') {
    throw new Error('Lease-bound agent execution requires macOS or Linux process-group cancellation; Windows is unsupported.');
  }
  const kind = cliAdapterKind(cli);
  const effectiveModel = resolveCliModel(cli, model);

  if (mode === 'agent' && transport === 'relay') {
    return runViaAgentRelay(kind, instruction, wakeContext, effectiveModel, relayContext, cwd, signal);
  }

  // Artifact detection brackets the spawn: the directory the CLI runs in is
  // snapshotted before and diffed after, by this process, on this
  // filesystem. Only an agent execution writes artifacts; an llm step has no
  // workspace to change. Executions sharing a working directory are
  // serialized around their snapshot-spawn-snapshot interval, so one agent's
  // writes are never attributed to a concurrent one in the same directory.
  //
  // This process writes its own evidence during that interval — the attempt's
  // transcript file and the two `flows status --tail` tails — and when the data
  // dir sits under the cwd (a local `--data-dir` inside the project) they all
  // land inside the scanned tree. None of them is agent-authored content, so
  // every one is dropped from the diff by path. Missing any of them reports
  // our own bookkeeping back to the kernel as the step's artifacts.
  const artifactRoot = mode === 'agent' ? resolve(cwd ?? process.cwd()) : undefined;
  return artifactRoot === undefined
    ? execute()
    : serializedByDirectory(artifactRoot, async () => {
      const before = await snapshotWorkspaceFiles(artifactRoot);
      const result = await execute();
      const ours = new Set<string>();
      for (const path of [result.transcript?.file?.path, ...tailPaths(sidechannel)]) {
        const real = realPath(path);
        if (real !== undefined) ours.add(real);
      }
      const artifacts = diffWorkspaceFiles(before, await snapshotWorkspaceFiles(artifactRoot))
        .filter(path => {
          const real = realPath(resolve(artifactRoot, path));
          return real === undefined || !ours.has(real);
        });
      return { ...result, artifacts };
    });

  async function execute(): Promise<WorkerCliResult> {
  if (kind === 'relayflows-wrapper-v1') {
    // The closed allowlist admits no ambient RELAYFLOW_* value; the four
    // discovery names are set from this dispatch, exactly as for a direct spawn.
    const wrapperEnv = wrapperEnvironment(process.env);
    applyStepEnvironment(wrapperEnv, sidechannel);
    return requirePricedUsage(decodeWrapperResult(await runWrapperSession(
      cli,
      instruction,
      wakeContext,
      effectiveModel,
      wrapperEnv,
      wrapperLimits,
      signal,
      cwd,
    )), effectiveModel);
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env[WAKE_CONTEXT_ENV];
  delete env[MODEL_ENV];
  // Where this attempt's journal is, so the agent can run `flows status` on
  // itself. Only a worker with a data dir knows; an ad-hoc spawn exports nothing.
  applyStepEnvironment(env, sidechannel);
  const invocation = mode === 'llm' ? llmExecution(kind, instruction, effectiveModel) : agentExecution(kind, instruction, effectiveModel);

  if (wakeContext !== undefined) {
    try {
      env[WAKE_CONTEXT_ENV] = JSON.stringify(wakeContext);
    } catch (error) {
      return {
        exit_code: null,
        stdout_tail: '',
        stderr_tail: `wake_context could not be JSON-serialized for the CLI: ${String(error)}`,
      };
    }
  }

  if (invocation.modelEnv !== undefined) env[MODEL_ENV] = invocation.modelEnv;
  // Structured provider output carries the authoritative token counts. Claude
  // streams it, so its final result is seen when it is emitted rather than
  // only once the process exits — which, after a background task, it may not.
  const args = [...invocation.args];
  args.splice(args.length - 1, 0, ...(kind === 'claude' ? ['--output-format', 'stream-json', '--verbose'] : ['--json']));
  const completion = kind === 'claude' ? claudeResultOutcome : undefined;
  return requirePricedUsage(decodeProviderResult(await spawnInvocation(cli, { ...invocation, args }, env, signal, sidechannel, cwd, completion), kind, env), effectiveModel);
  }
}

function openTails(context: SidechannelContext): { stdout: TranscriptTailWriter; stderr: TranscriptTailWriter } | undefined {
  // Same rule as the per-attempt transcript file: no attempt, no tails.
  const attempt = context.attempt;
  if (attempt === undefined) return undefined;
  const identity = { dataDir: context.dataDir, runId: context.runId, stepId: context.stepId, attempt };
  try {
    return { stdout: openTranscriptTail(identity, 'stdout'), stderr: openTranscriptTail(identity, 'stderr') };
  } catch {
    // An id the path cannot carry; the sidechannel declined it the same way.
    return undefined;
  }
}

/**
 * Where this attempt's `--tail` files are, so the artifact diff can drop them.
 * Empty when there is no sidechannel or no attempt to name, which is exactly
 * when `openTails` declines to write any.
 */
function tailPaths(context: SidechannelContext | undefined): string[] {
  const attempt = context?.attempt;
  if (context === undefined || attempt === undefined) return [];
  const identity = { dataDir: context.dataDir, runId: context.runId, stepId: context.stepId, attempt };
  try {
    // Both the finished file and the `.tmp` the writer stages and renames over
    // (`transcript-tail.ts`): a close that timed out or a flush that failed can
    // leave the staging file behind, and it is no more agent-authored than the
    // file it was going to become.
    return ['stdout', 'stderr'].flatMap((stream) => {
      const path = transcriptTailPath(identity, stream as 'stdout' | 'stderr');
      return [path, `${path}.tmp`];
    });
  } catch {
    // An id the path cannot carry; no tails were written either.
    return [];
  }
}

/** Symlink-free form of a path, or the path itself when it cannot be resolved. */
function realPath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  try { return realpathSync(path); } catch { return path; }
}

/** One agent at a time per canonical working directory, for the artifact interval. */
const directoryQueues = new Map<string, Promise<unknown>>();
function serializedByDirectory<T>(directory: string, task: () => Promise<T>): Promise<T> {
  const previous = directoryQueues.get(directory) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(() => undefined, () => undefined);
  directoryQueues.set(directory, settled);
  void settled.then(() => { if (directoryQueues.get(directory) === settled) directoryQueues.delete(directory); });
  return run;
}

/** Wait under the same worker lease for an authoritative task receipt. */
async function runViaAgentRelay(
  kind: CliAdapterKind, instruction: string, wakeContext: unknown,
  model: string | undefined, context: AgentRelayContext | undefined,
  worker_cwd: string | undefined, signal: AbortSignal | undefined,
): Promise<WorkerCliResult> {
  try {
    if (kind === 'relayflows-wrapper-v1') throw new Error('Relay task transport does not support same-process wrappers.');
    if (!context?.dataDir) throw new Error('Relay task transport requires a durable data directory and journal dispatch identity.');
    const task = instruction + (wakeContext === undefined ? '' : `\n\nWake context (journaled):\n${JSON.stringify(wakeContext)}`)
      + '\n\nReport the final task output with the injected agent_result tool and final=true. Wait for its successful durable acknowledgment before exiting.';
    const received = await runAgentRelayTask({
      cli: kind, task, model, worker_cwd, result_schema: context.resultSchema,
      runId: context.runId, stepId: context.stepId, idempotencyKey: context.idempotencyKey,
      dataDir: context.dataDir,
    }, { signal });
    const receipt = { ...received, error: received.error === null ? null : redactRelayError(received.error) };
    const accounting = receipt.task_execution.accounting;
    const result: WorkerCliResult = {
      relay_task: receipt, exit_code: receipt.status === 'completed' ? 0 : 1,
      stdout_tail: receipt.status === 'completed' ? JSON.stringify(receipt.output) : '',
      stderr_tail: receipt.status === 'failed' ? `Relay task failed: ${receipt.error}` : '',
      ...(accounting?.tokens_input === undefined ? {} : { tokens_input: accounting.tokens_input }),
      ...(accounting?.tokens_output === undefined ? {} : { tokens_output: accounting.tokens_output }),
    };
    return requirePricedUsage(result, model);
  } catch (error) {
    signal?.throwIfAborted();
    const detail = error instanceof AgentRelayTransportError ? error.message
      : error instanceof Error ? error.message : 'Relay task transport failed';
    return { exit_code: null, stdout_tail: '', stderr_tail: redactRelayError(detail) };
  }
}

/**
 * How long a CLI that has reported its final result may take to exit. Claude
 * Code in print mode waits, after its result, for every background task it
 * started to finish; one that never finishes kept a finished step running
 * until the whole run's deadline. Past this grace the result stands and the
 * tree is stopped.
 */
export const RESULT_EXIT_GRACE_MS = 30_000;

async function spawnInvocation(
  cli: string,
  invocation: CliInvocation,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  sidechannel?: SidechannelContext,
  cwd?: string,
  completion?: (line: string) => { failed: boolean } | undefined,
): Promise<WorkerCliResult> {
  let writeInput: (bytes: Buffer) => Promise<boolean> = async () => false;
  let canDrive = () => false;
  let driven = false;
  // The transcript file lives beside the PTY socket and is named by attempt.
  // Its absence (no data dir, no attempt, unwritable dir) costs the step
  // nothing: the digest is built from the buffered frames regardless. Opened
  // BEFORE the sidechannel: once `onReady` has fired, a drive peer's HELLO may
  // arrive at any time, and nothing may sit between that and the spawn that
  // arms `canDrive`.
  const writer: TranscriptWriter | undefined = sidechannel?.attempt === undefined ? undefined
    : await openTranscriptWriter(transcriptPath(sidechannel, sidechannel.attempt), env);
  const channel = sidechannel === undefined ? undefined : await openSidechannel({
    ...sidechannel,
    onDrive() { driven = true; sidechannel.onDrive(); },
  }, bytes => writeInput(bytes), () => canDrive());
  // Tee the transcript into bounded tail files beside the socket. Evidence
  // for `flows status --tail`, never the record; a failure here is a warning.
  const tails = sidechannel === undefined ? undefined : openTails(sidechannel);
  if (signal?.aborted) {
    channel?.close();
    void writer?.close();
    void tails?.stdout.close(); void tails?.stderr.close();
    signal.throwIfAborted();
  }
  return new Promise((resolve) => {
    // Always a group of its own off Windows, so every stop — and
    // `reapOnExit` — reaches the whole agent tree, lease-bound or not.
    const ownsGroup = process.platform !== 'win32';
    const child = spawn(cli, invocation.args, {
      stdio: ['pipe', 'pipe', 'pipe'], env,
      detached: ownsGroup,
      ...(cwd === undefined ? {} : { cwd }),
    });
    child.stdin.on('error', () => {});
    if (channel === undefined) child.stdin.end();
    canDrive = () => !child.stdin.destroyed && !child.stdin.writableEnded;
    // A pipe cannot be reopened after EOF. Give startup subscribers a bounded
    // chance to opt into drive, then let unattended/view-only CLIs read EOF.
    const inputTimer = channel === undefined ? undefined : setTimeout(() => {
      if (!driven) child.stdin.end();
    }, 100);
    writeInput = bytes => new Promise(resolve => {
      if (!canDrive()) { resolve(false); return; }
      // write(false) still accepts the bytes. The completion callback waits
      // until they flush; the sidechannel pauses its reader in the meantime.
      child.stdin.write(bytes, error => resolve(!error));
    });
    const stop = childStop(child, ownsGroup);
    const release = ownsGroup ? reapOnExit(stop) : () => {};
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    const decoder = new StringDecoder('utf8');
    let partialLine = '';
    const finish = (result: WorkerCliResult, discardTranscript = false): void => {
      if (settled) return;
      settled = true;
      if (inputTimer !== undefined) clearTimeout(inputTimer);
      channel?.close();
      if (timer !== undefined) clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      signal?.removeEventListener('abort', onAbort);
      if (writer === undefined && tails === undefined) { resolve(result); return; }
      if (writer !== undefined) {
        const rest = partialLine + decoder.end();
        if (rest.length > 0) writer.write(rest);
      }
      // Two independent pieces of evidence close here: the per-attempt
      // transcript, whose descriptor rides back on the result as the digest's
      // file pointer, and the `flows status --tail` tails, which nothing reads
      // from the result.
      //
      // Neither may hold a step open. A stalled write would leave
      // `runAgentCli` unresolved forever, and every later abort or timeout is
      // already a no-op once `settled` is true — so the whole close is raced
      // against a bounded deadline and the result stands either way. Past the
      // deadline the transcript pointer is dropped rather than waited for: a
      // completion without a pointer is recoverable, a step that never
      // completes is not.
      // The writer's result is recorded the moment it lands, not read out of
      // the combined race: the two closes are independent, and a stalled tail
      // must not throw away a transcript that finished and is on disk.
      let transcriptFile: TranscriptFile | undefined;
      const closedWriter = writer === undefined
        ? Promise.resolve()
        : writer.close().then((file) => { transcriptFile = file; }, () => {});
      const closedTails = tails === undefined
        ? Promise.resolve()
        : Promise.all([tails.stdout.close(), tails.stderr.close()]).then(() => undefined, () => undefined);
      const deadline = new Promise<void>((done) => setTimeout(done, TAIL_CLOSE_TIMEOUT_MS).unref?.());
      void Promise.race([Promise.all([closedWriter, closedTails]), deadline]).then(() => {
        resolve(discardTranscript || transcriptFile === undefined
          ? result : { ...result, transcript: { file: transcriptFile } });
      }, () => resolve(result));
    };
    const onAbort = (): void => {
      stop.kill();
      finish({ exit_code: null, stdout_tail: '', stderr_tail: 'Agent execution aborted: lease ownership lost.' }, true);
    };
    /**
     * Same invariant as `wrapper-session.ts`: `'close'` and `'error'` are
     * evidence about the DIRECT CHILD, so they may not settle over a pending
     * escalation, and only `maySettleOnChildExit` may drop one. This settle
     * carries no deadline of its own because it needs none — the timeout below
     * settles on the spot and lets its escalation outlive that, so refusing
     * here can only defer to a `'close'` we are still going to get.
     */
    const finishOnChildExit = (result: WorkerCliResult): void => {
      if (!stop.maySettleOnChildExit()) return;
      finish(result);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    /**
     * The CLI has reported its final result. A normal exit inside the grace
     * settles through `'close'` exactly as before, with the real exit code.
     * Past it, the result settles the step with the exit status that result
     * would have carried, and the stop outlives the settle as the timeout's
     * does.
     */
    const onResult = (outcome: { failed: boolean }): void => {
      if (graceTimer !== undefined || settled) return;
      graceTimer = setTimeout(() => {
        stop.terminate();
        finish({
          exit_code: outcome.failed ? 1 : 0,
          stdout_tail: Buffer.concat(stdout).toString('utf8'),
          stderr_tail: `${Buffer.concat(stderr).toString('utf8')}\nCLI reported its final result but had not exited ${RESULT_EXIT_GRACE_MS}ms later; its process tree was stopped.`.trim(),
        });
      }, RESULT_EXIT_GRACE_MS);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      channel?.publish(chunk);
      // The tails take raw bytes, so they are fed before any line splitting
      // and regardless of what the writer or the detector still wants.
      tails?.stdout.append(chunk);
      // Lines are split whenever a writer or a completion detector wants
      // them; the detector stops looking once a result has been seen, the
      // writer keeps every line to the end.
      if (writer === undefined && (completion === undefined || graceTimer !== undefined)) return;
      const lines = (partialLine + decoder.write(chunk)).split('\n');
      partialLine = lines.pop() ?? '';
      for (const line of lines) {
        writer?.write(line);
        if (completion === undefined || graceTimer !== undefined) continue;
        const outcome = completion(line);
        if (outcome !== undefined) onResult(outcome);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk); channel?.publish(chunk); tails?.stderr.append(chunk); });
    child.once('error', (error) => finishOnChildExit({
      exit_code: null,
      stdout_tail: Buffer.concat(stdout).toString('utf8'),
      stderr_tail: error.message,
    }));
    child.once('error', () => { if (child.pid === undefined) release(); });
    child.once('close', release);
    child.once('close', (code) => finishOnChildExit({
      exit_code: code,
      stdout_tail: Buffer.concat(stdout).toString('utf8'),
      stderr_tail: Buffer.concat(stderr).toString('utf8'),
    }));
    if (invocation.timeoutMs > 0) {
      timer = setTimeout(() => {
        // The stop outlives this settle on purpose: `finish` resolves the step,
        // but only the forced group kill releases the pipes a leaked descendant
        // is holding, and until they are released `flows run` cannot exit.
        stop.terminate();
        finish({
          exit_code: null,
          stdout_tail: Buffer.concat(stdout).toString('utf8'),
          stderr_tail: `CLI invocation timed out after ${invocation.timeoutMs}ms.`,
        });
      }, invocation.timeoutMs);
    }
  });
}
