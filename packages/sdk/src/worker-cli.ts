import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { diffWorkspaceFiles, snapshotWorkspaceFiles } from './agent-artifacts.js';
import { claudeResultOutcome, decodeProviderResult, decodeWrapperResult, requirePricedUsage } from './worker-usage.js';
import { openSidechannel, type SidechannelContext } from './pty-sidechannel.js';
import {
  openTranscriptWriter,
  redactText,
  transcriptPath,
  type TranscriptDigest,
  type TranscriptFile,
  type TranscriptWriter,
} from './agent-transcript.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { redactRelayError } from './redact.js';
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
import { applyStepEnvironment } from './step-env.js';
import { TAIL_CLOSE_TIMEOUT_MS, openTranscriptTail, type TranscriptTailWriter } from './transcript-tail.js';
import {
  isRetryableSpawnError,
  transportEvidence,
  type CliTransportCause,
  type CliTransportEvidence,
} from './cli-transport-evidence.js';
import {
  runAgentRelayTask,
  AgentRelayTransportError,
  type AgentTransport,
} from './agent-relay-transport.js';
import { pinCliAlias } from './cli/pinned-cli-alias.js';

export type { CliTransportCause, CliTransportEvidence, CliTransportPhase } from './cli-transport-evidence.js';
export { agentCompletionReason } from './cli-transport-evidence.js';

/** Present only when a dispatched agent step carries a journaled wake context. */
export const WAKE_CONTEXT_ENV = 'RELAYFLOW_WAKE_CONTEXT';

/**
 * Private wrapper model variable name. Ambient values are scrubbed; a wrapper
 * may set it inside the already-identified process from the session request.
 * Raw Claude/Codex adapters receive provider-native model flags.
 */
export const MODEL_ENV = 'RELAYFLOW_MODEL';

/** Preserve a multicall adapter's authored basename while executing pinned bytes. */
export function cliInvocationArgv0(cli: string, cliIdentity?: string): string {
  return basename(cliIdentity ?? cli);
}

export interface WorkerCliResult {
  relay_task?: import('./agent-relay-receipt.js').RelayTaskReceipt;
  tokens_input?: number;
  tokens_output?: number;
  exit_code: number | null;
  stdout_tail: string;
  stderr_tail: string;
  /**
   * Bounded, redacted process-lifecycle evidence for a direct CLI spawn.
   * This is journaled in `trajectory_tail`, including when parsed JSON output
   * would otherwise discard the process wrapper.
   */
  transport?: CliTransportEvidence;
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
  processEnvironment: NodeJS.ProcessEnv = process.env,
  cliIdentity?: string,
  // Trailing parameter preserves existing positional callers.
  stepTimeoutMs?: number,
): Promise<WorkerCliResult> {
  signal?.throwIfAborted();
  if (signal !== undefined && process.platform === 'win32') {
    throw new Error('Lease-bound agent execution requires macOS or Linux process-group cancellation; Windows is unsupported.');
  }
  const kind = cliAdapterKind(cliIdentity ?? cli);
  const effectiveModel = resolveCliModel(cliIdentity ?? cli, model);
  const argv0 = cliInvocationArgv0(cli, cliIdentity);

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
  // Bookkeeping written during that interval is not agent-authored content,
  // and when the data dir sits under the cwd (a local `--data-dir` inside the
  // project) all of it lands inside the scanned tree: this process's own
  // transcript file and two `flows status --tail` tails, and the run journals
  // the daemon appends to while the agent runs. So the whole data dir is
  // dropped from the diff. Anything left in reports the kernel's own state
  // back to the kernel as the step's artifacts, where an `artifact_exists`
  // gate then reads it.
  const artifactRoot = mode === 'agent' ? resolve(cwd ?? process.cwd()) : undefined;
  return artifactRoot === undefined
    ? execute()
    : serializedByDirectory(canonicalTree(artifactRoot), async () => {
      const before = await snapshotWorkspaceFiles(artifactRoot);
      const result = await execute();
      const kernelData = sidechannel === undefined ? undefined : realPath(resolve(sidechannel.dataDir));
      const artifacts = diffWorkspaceFiles(before, await snapshotWorkspaceFiles(artifactRoot))
        .filter(path => !under(realPath(resolve(artifactRoot, path)), kernelData));
      return { ...result, artifacts };
    });

  async function execute(): Promise<WorkerCliResult> {
  if (kind === 'relayflows-wrapper-v1') {
    // The closed allowlist admits no ambient RELAYFLOW_* value; the four
    // discovery names are set from this dispatch, exactly as for a direct spawn.
    const wrapperEnv = wrapperEnvironment(processEnvironment);
    applyStepEnvironment(wrapperEnv, sidechannel);
    return requirePricedUsage(decodeWrapperResult(await runWrapperSession(
      cli,
      instruction,
      wakeContext,
      effectiveModel,
      wrapperEnv,
      stepTimeoutMs === undefined ? wrapperLimits : { ...wrapperLimits, executionTimeoutMs: stepTimeoutMs },
      signal,
      cwd,
      argv0,
    )), effectiveModel);
  }

  const env: NodeJS.ProcessEnv = { ...processEnvironment };
  delete env[WAKE_CONTEXT_ENV];
  delete env[MODEL_ENV];
  // Where this attempt's journal is, so the agent can run `flows status` on
  // itself. Only a worker with a data dir knows; an ad-hoc spawn exports nothing.
  applyStepEnvironment(env, sidechannel);
  const invocation = mode === 'llm' ? llmExecution(kind, instruction, effectiveModel) : agentExecution(kind, instruction, effectiveModel);

  if (stepTimeoutMs !== undefined) invocation.timeoutMs = stepTimeoutMs;

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
  return requirePricedUsage(decodeProviderResult(await spawnInvocation(
    cli, { ...invocation, args }, env, signal, sidechannel, cwd, completion, argv0, kind,
  ), kind, env), effectiveModel);
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
 * Whether `path` is `directory` or anything beneath it, both symlink-free.
 *
 * The artifact exclusion is a subtree, not a list of names, because the files
 * to exclude are not all knowable in advance. The attempt's own transcript and
 * tails are (they derive from the attempt identity), but the daemon decides on
 * its own when to write which run journal, and a journal appended to inside
 * the snapshot interval is indistinguishable in a diff from a file the agent
 * wrote. Excluding the directory covers both, and covers them without reading
 * the result: the transcript pointer there is optional — `finish` drops it
 * when the close outruns `TAIL_CLOSE_TIMEOUT_MS` and `discardTranscript` drops
 * it on abort, while the file stays on disk — so an exclusion built from it
 * lost the transcript exactly when the close was slow (flows#495).
 *
 * `false` when there is no data dir to exclude, which is exactly when this
 * process has nowhere to write.
 */
function under(path: string | undefined, directory: string | undefined): boolean {
  if (path === undefined || directory === undefined) return false;
  return path === directory || path.startsWith(directory.endsWith(sep) ? directory : directory + sep);
}

/**
 * Symlink-free form of an absolute path that may not exist yet: the deepest
 * existing ancestor is resolved and the missing tail is kept. A plain
 * `realPath` fallback would leave `/link/new` unresolved while `/link`
 * resolves, and the overlap check would then treat them as disjoint trees.
 */
export function canonicalTree(path: string): string {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** Symlink-free form of a path, or the path itself when it cannot be resolved. */
function realPath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  try { return realpathSync(path); } catch { return path; }
}

/**
 * One agent at a time per overlapping working tree, for the artifact interval.
 *
 * `directory` must be canonical (symlink-free): `/repo` and a `/tmp/link` to it
 * are one tree. Two trees overlap when one contains the other, because the
 * snapshot walks the whole subtree — an agent in `/repo` would otherwise be
 * credited with files an agent in `/repo/.wt/api` wrote meanwhile. Disjoint
 * trees (sibling worktrees) run side by side. Each run waits for every
 * earlier-registered overlapping run, so order within an overlap is arrival.
 */
const directoryRuns = new Set<{ readonly directory: string; readonly settled: Promise<void> }>();
function serializedByDirectory<T>(directory: string, task: () => Promise<T>): Promise<T> {
  const blockers = [...directoryRuns]
    .filter(other => under(other.directory, directory) || under(directory, other.directory))
    .map(other => other.settled);
  const run = Promise.all(blockers).then(task);
  const entry = { directory, settled: run.then(() => undefined, () => undefined) };
  directoryRuns.add(entry);
  void entry.settled.then(() => { directoryRuns.delete(entry); });
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
  argv0?: string,
  kind?: CliAdapterKind,
): Promise<WorkerCliResult> {
  const pendingInput: Buffer[] = [];
  let acceptingDrive = true;
  let writeInput: (bytes: Buffer) => Promise<boolean> = async bytes => {
    pendingInput.push(Buffer.from(bytes));
    return true;
  };
  let canDrive = () => acceptingDrive;
  let driven = false;
  // Prove and pin the authored identity before opening any per-attempt
  // resources. If pinning fails there is then nothing else to unwind.
  const pinned = await pinCliAlias(cli, argv0 ?? basename(cli));
  if (signal?.aborted) {
    pinned.release();
    signal.throwIfAborted();
  }
  // The transcript file lives beside the PTY socket and is named by attempt.
  // Its absence (no data dir, no attempt, unwritable dir) costs the step
  // nothing: the digest is built from the buffered frames regardless. Opened
  // BEFORE the sidechannel: once `onReady` has fired, a drive peer's HELLO may
  // arrive at any time, and nothing may sit between that and the spawn that
  // arms `canDrive`.
  let writer: TranscriptWriter | undefined;
  let channel: Awaited<ReturnType<typeof openSidechannel>> | undefined;
  let tails: ReturnType<typeof openTails>;
  const closeBeforeSpawn = async (): Promise<void> => {
    channel?.close();
    const closing = Promise.allSettled([
      ...(writer === undefined ? [] : [writer.close()]),
      ...(tails === undefined ? [] : [tails.stdout.close(), tails.stderr.close()]),
    ]);
    pinned.release();
    const deadline = new Promise<void>((done) => setTimeout(done, TAIL_CLOSE_TIMEOUT_MS).unref?.());
    await Promise.race([closing, deadline]);
  };
  try {
    writer = sidechannel?.attempt === undefined ? undefined
      : await openTranscriptWriter(transcriptPath(sidechannel, sidechannel.attempt), env);
    channel = sidechannel === undefined ? undefined : await openSidechannel({
      ...sidechannel,
      onDrive() { driven = true; sidechannel.onDrive(); },
    }, bytes => writeInput(bytes), () => canDrive());
    // Decide the child's stdin shape before spawn. An unattended Codex process
    // gets `/dev/null` from `ignore`, so it never enters the "additional input
    // from stdin" path. Only an already-enrolled drive peer gets a writable
    // pipe. View/passthrough retain live output without changing stdin.
    driven = channel === undefined ? false : await channel.waitForDrive(100);
    acceptingDrive = false;
    // Tee the transcript into bounded tail files beside the socket. Evidence
    // for `flows status --tail`, never the record; a failure here is a warning.
    tails = sidechannel === undefined ? undefined : openTails(sidechannel);
  } catch (error) {
    await closeBeforeSpawn();
    throw error;
  }
  if (signal?.aborted) {
    await closeBeforeSpawn();
    signal.throwIfAborted();
  }
  // Always a group of its own off Windows, so every stop — and
  // `reapOnExit` — reaches the whole agent tree, lease-bound or not.
  const ownsGroup = process.platform !== 'win32';
  let child: ChildProcess;
  try {
    child = spawn(pinned.executable, invocation.args, {
      stdio: [driven ? 'pipe' : 'ignore', 'pipe', 'pipe'], env,
      detached: ownsGroup,
      ...(argv0 === undefined ? {} : { argv0 }),
      ...(cwd === undefined ? {} : { cwd }),
    });
  } catch (error) {
    await closeBeforeSpawn();
    throw error;
  }
  return new Promise((resolve) => {
    const stdin = child.stdin;
    stdin?.on('error', () => {});
    canDrive = () => stdin !== null && !stdin.destroyed && !stdin.writableEnded;
    let inputQueue = Promise.resolve(true);
    writeInput = bytes => {
      inputQueue = inputQueue.then(previousAccepted => {
        if (!previousAccepted || !canDrive()) return false;
        return new Promise<boolean>(resolve => {
          // write(false) still accepts the bytes. The completion callback
          // waits until they flush; the sidechannel pauses its reader.
          stdin!.write(bytes, error => resolve(!error));
        });
      });
      return inputQueue;
    };
    for (const bytes of pendingInput.splice(0)) void writeInput(bytes);
    // The last driver leaving is the end of input: flush what it sent, then
    // EOF. Without it a driven Codex waits on its stdin lifecycle forever.
    if (driven) {
      channel?.whenDriveIdle(() => {
        inputQueue = inputQueue.then(() => {
          if (canDrive()) stdin!.end();
          return false;
        });
      });
    }
    let release = () => {};
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
    let pendingStopResult: {
      result: WorkerCliResult;
      discardTranscript: boolean;
      priority: 'normal' | 'abort';
    } | undefined;
    const stop = childStop(child, ownsGroup, undefined, (stopError) => {
      if (stopError !== undefined) {
        finish({ exit_code: null, stdout_tail: '', stderr_tail: stopError.message }, true);
        return;
      }
      try {
        pinned.release();
      } catch (error) {
        finish({
          exit_code: null,
          stdout_tail: '',
          stderr_tail: `CLI invocation alias cleanup failed: ${String(error)}`,
        }, true);
        return;
      }
      if (pendingStopResult !== undefined) {
        finish(pendingStopResult.result, pendingStopResult.discardTranscript);
      }
    });
    release = ownsGroup ? reapOnExit(stop, () => {
      try { pinned.release(); } catch { /* host exit cannot report another result */ }
    }) : () => {};
    const finishAfterStop = (
      result: WorkerCliResult,
      action: 'kill' | 'terminate',
      discardTranscript = false,
      priority: 'normal' | 'abort' = 'normal',
    ): void => {
      // Lease loss may replace an earlier result while its stop is pending;
      // once it does, no later result-grace or execution timer may replace it.
      if (pendingStopResult !== undefined) {
        if (pendingStopResult.priority === 'abort' || priority === 'normal') return;
      }
      pendingStopResult = { result, discardTranscript, priority };
      stop[action]();
    };
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      graceTimer = undefined;
      const transport = transportEvidence({
        phase: 'abort', cause: 'lease_lost', exitCode: null, signal: null,
        stderr: 'Agent execution aborted: lease ownership lost.', retryable: false,
      }, env);
      finishAfterStop(
        { exit_code: null, stdout_tail: '', stderr_tail: 'Agent execution aborted: lease ownership lost.', transport },
        'kill',
        true,
        'abort',
      );
    };
    /**
     * Same invariant as `wrapper-session.ts`: `'close'` and `'error'` are
     * evidence about the DIRECT CHILD, so they may not settle over a pending
     * escalation, and only `maySettleOnChildExit` may drop one. This settle
     * carries no deadline of its own because it needs none — a stop-owned
     * result now settles from the shared confirmation callback, while a normal
     * child exit can only defer to a `'close'` we are still going to get.
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
        const exitCode = outcome.failed ? 1 : 0;
        const stderrText = `${Buffer.concat(stderr).toString('utf8')}\nCLI reported its final result but had not exited ${RESULT_EXIT_GRACE_MS}ms later; its process tree was stopped.`.trim();
        const transport = transportEvidence({
          phase: 'result_exit_grace', cause: 'result_exit_timeout', exitCode, signal: null,
          stderr: stderrText,
          retryable: false,
        }, env);
        finishAfterStop({
          exit_code: exitCode,
          stdout_tail: Buffer.concat(stdout).toString('utf8'),
          stderr_tail: redactText(stderrText, env),
          transport,
        }, 'terminate');
      }, RESULT_EXIT_GRACE_MS);
    };
    child.stdout!.on('data', (chunk: Buffer) => {
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
    child.stderr!.on('data', (chunk: Buffer) => { stderr.push(chunk); channel?.publish(chunk); tails?.stderr.append(chunk); });
    child.once('error', (error) => {
      const code = typeof (error as NodeJS.ErrnoException).code === 'string'
        ? (error as NodeJS.ErrnoException).code : undefined;
      const retryable = isRetryableSpawnError(code);
      const transport = transportEvidence({
        phase: 'spawn', cause: child.pid === undefined ? 'spawn_error' : 'process_error',
        exitCode: null, signal: null, stderr: error.message, errorCode: code, retryable,
      }, env);
      finishOnChildExit({
        exit_code: null,
        stdout_tail: Buffer.concat(stdout).toString('utf8'),
        stderr_tail: redactText(error.message, env),
        transport,
      });
    });
    child.once('error', () => { if (child.pid === undefined) release(); });
    child.once('close', release);
    child.once('close', (code, signalName) => {
      const stderrText = Buffer.concat(stderr).toString('utf8');
      const codexStdinLifecycle = kind === 'codex' && code === 1
        && stderrText.trim() === 'Reading additional input from stdin...';
      const cause: CliTransportCause = codexStdinLifecycle ? 'codex_stdin_lifecycle'
        : signalName !== null ? 'signal'
          : code === null ? 'close_without_status'
            : code === 0 ? 'exited' : 'nonzero_exit';
      const retryable = codexStdinLifecycle || signalName !== null || code === null;
      const transport = transportEvidence({
        phase: 'close', cause, exitCode: code, signal: signalName, stderr: stderrText, retryable,
      }, env);
      finishOnChildExit({
        exit_code: code,
        stdout_tail: Buffer.concat(stdout).toString('utf8'),
        stderr_tail: redactText(stderrText, env),
        transport,
      });
    });
    if (invocation.timeoutMs > 0) {
      timer = setTimeout(() => {
        // The stop owns this settle: a direct-child event is not proof that its
        // group is gone, and an unprovable forced stop must fail the step rather
        // than arriving after a successful result has already won the race.
        const timeoutMessage = `CLI invocation timed out after ${invocation.timeoutMs}ms.`;
        const transport = transportEvidence({
          phase: 'timeout', cause: 'timeout', exitCode: null, signal: null,
          stderr: `${Buffer.concat(stderr).toString('utf8')}\n${timeoutMessage}`,
          retryable: false,
        }, env);
        finishAfterStop({
          exit_code: null,
          stdout_tail: Buffer.concat(stdout).toString('utf8'),
          stderr_tail: timeoutMessage,
          transport,
        }, 'terminate');
      }, invocation.timeoutMs);
    }
  });
}
