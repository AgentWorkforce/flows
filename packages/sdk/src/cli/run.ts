import { parseHumanRecipient } from '../human-to.js';
import { parseDigestReference } from '../bundle-transport.js';
import { prepareDigestRun } from './run-digest.js';
import { reuseSummary } from './reuse.js';
import { resumeHelperEffect } from '../authored-helper-effect.js';
import { AuthoredFlowExecutionError, AuthoredHumanParked, type AuthoredHumanWait } from '../authored-flow-error.js';
import { answerCommand, resumeCommand } from '../authored-human.js';
import { join, resolve } from 'node:path';
import type { ProgressEvent } from '../progress.js';
import { toKernelSpec } from '../compile.js';
import { socketPathFor } from '../daemon-connection.js';
import { ensureDaemon, type EnsureDaemonOptions } from '../daemon-lifecycle.js';
import { isAuthoredFlowPath } from '../direct-input.js';
import { daemonRefusal } from './daemon-refusal.js';
import type { RunFailureKind, RunWarningKind, StepFailedDetails } from '../failure-kinds.js';
import { inspectionHint, renderInspection, renderStepEvidence, stepFailureDetails } from './step-failure.js';
import { JournalClient, JournalProtocolError } from '../journal-client.js';
import { attachLocalAgent } from '../local-agent.js';
import { LlmWorker } from '../llm-worker.js';
import { readAuthoredRootMetadata, resumeDurableAuthoredFlow } from '../authored-root.js';
import type {
  RunCompletionReason,
  RunOutcome,
  RunStatus,
} from '../protocol.js';
import type { StepType } from '../spec.js';
import type { LoweredCompletionReason } from '../authored-flow-executor.js';
import {
  checkFlow,
  type CheckReport,
} from './check.js';

export type RunExitCode = 0 | 1 | 2 | 3;
export type RunCommand = 'run' | 'resume' | 'answer';

export interface ParkedStep {
  id: string;
  type: Extract<StepType, 'llm' | 'agent'>;
}

export interface RunDiagnostic extends StepFailedDetails {
  severity: 'refusal' | 'failure' | 'parked' | 'warning' | 'declined';
  kind: RunFailureKind | RunWarningKind | RunCompletionReason;
  message: string;
}

export interface RunReport {
  ok: boolean;
  command: RunCommand;
  path?: string;
  runId?: string;
  socketPath?: string;
  status?: RunStatus;
  completionReason?: RunCompletionReason;
  completedSteps?: number;
  reuse?: { fromRunId: string; reusedSteps: number; executedSteps: number };
  parkedStep?: ParkedStep;
  /** The open `f.human` question a parked authored run is waiting on. */
  humanWait?: AuthoredHumanWait;
  /** `flows answer` only: the answer it recorded. */
  answer?: { waitId: string; answer: boolean; note?: string };
  /** The invocation that continues this run, when one is known. */
  next?: string;
  projectConfigPath?: string;
  resolutions: CheckReport['resolutions'];
  diagnostics: Array<CheckReport['diagnostics'][number] | RunDiagnostic>;
}

export interface RunExecution {
  exitCode: RunExitCode;
  report: RunReport;
}

export interface RunProgress {
  runId: string;
  stepId: string;
  stepType: Extract<StepType, 'llm' | 'agent'>;
  leaseDeadlineMs: number;
}

export interface RunLifecycleOptions {
  /** Caller-owned hosted invocation identity for authored-root start recovery. */
  authoredAdmissionKey?: string;
  bucket?: string;
  allowHumanInfluenced?: boolean;
  onPtyReady?: (path: string) => void;
  reuseFromRunId?: string;
  onProgress?: (event: ProgressEvent) => void;
  localAgent?: boolean;
  signal?: AbortSignal;
  onWait?: (progress: RunProgress) => void;
  /**
   * The daemon data dir, carried so a failure diagnostic can name the journal
   * holding the evidence (`<dataDir>/runs/<runId>.sqlite3`) and emit a
   * `flows replay` invocation that will actually resolve. Each verb sets it
   * from its own `--data-dir`; absent only where no data dir exists, and the
   * diagnostic then omits the path rather than guessing one.
   */
  dataDir?: string;
  /**
   * Attach-or-spawn policy for the daemon this command needs
   * (kernel/DAEMON-LIFECYCLE.md §3). `{ spawn: false }` is `--no-spawn`:
   * refuse instead of starting one, which is today's exact behavior.
   */
  daemon?: EnsureDaemonOptions;
}

export async function runFlow(
  path: string,
  dataDir: string,
  options: RunLifecycleOptions = {},
): Promise<RunExecution> {
  const prepared = parseDigestReference(path) ? await prepareDigestRun(path, options.bucket) : undefined;
  if (prepared && 'exitCode' in prepared) return prepared;
  const checked = prepared ?? checkFlow(path);
  if (!checked.report.ok || checked.flow === undefined) {
    return { exitCode: 2, report: fromCheckReport('run', checked.report) };
  }

  return executeCheckedFlow(checked, dataDir, options);
}

async function executeCheckedFlow(
  checked: ReturnType<typeof checkFlow>,
  dataDir: string,
  options: RunLifecycleOptions,
): Promise<RunExecution> {
  const socketPath = socketFor(dataDir);
  // Carry the preflight's diagnostics as a RunReport from here on, so the
  // attach step has one accumulator to append to (see `connect`).
  const base = fromCheckReport('run', checked.report);
  const client = new JournalClient(socketPath);
  const connected = await connect(client, 'run', dataDir, base, options);
  if (connected !== undefined) return connected;

  let localAgent: Awaited<ReturnType<typeof attachLocalAgent>> | undefined;
  try {
    const spec = toKernelSpec(checked.flow!);
    // Use the checked CLI/model and declared surfaces unchanged. The worker
    // advertises its existing pins; the daemon still owns surface matching.
    if (options.localAgent) localAgent = await attachLocalAgent(client, dataDir, options.onPtyReady);
    const outcome = await client.runStart(spec, options.reuseFromRunId);
    const execution = await classifyOutcome(client, 'run', outcome, base, socketPath, { ...options, dataDir });
    if (options.reuseFromRunId !== undefined) {
      execution.report.reuse = await reuseSummary(client, outcome.run_id, options.reuseFromRunId);
    }
    return execution;
  } catch (error) {
    if (error instanceof JournalProtocolError && (
      error.code === 'reuse_spec_mismatch' || error.code === 'reuse_run_not_found'
      || error.code === 'reuse_journal_read_failed'
    )) {
      const failed = error.code === 'reuse_journal_read_failed';
      return { exitCode: failed ? 1 : 2, report: { ...base, socketPath,
        diagnostics: [...base.diagnostics, { severity: failed ? 'failure' : 'refusal',
          kind: error.code, message: error.message }] } };
    }
    return protocolFailure('run', base, socketPath, localAgent?.failure ?? error);
  } finally {
    try { await localAgent?.close(); } finally { client.close(); }
  }
}

export async function resumeFlow(
  runId: string,
  dataDir: string,
  options: RunLifecycleOptions = {},
): Promise<RunExecution> {
  const socketPath = socketFor(dataDir);
  const base = emptyReport('resume');
  const client = new JournalClient(socketPath);
  const connected = await connect(client, 'resume', dataDir, base, options);
  if (connected !== undefined) return connected;

  let authoredAgent: Awaited<ReturnType<typeof attachLocalAgent>> | undefined;
  let authoredLlm: LlmWorker | undefined;
  let authoredLlmClient: JournalClient | undefined;
  try {
    const authoredRoot = await readAuthoredRootMetadata(client, runId);
    if (authoredRoot !== undefined) {
      if (authoredRoot.localAgentStream !== undefined && !options.localAgent) {
        throw new Error('authored root requires --local-agent to resume its pinned worker surface');
      }
      if (authoredRoot.localAgentStream === undefined && options.localAgent) {
        throw new Error('authored root was started without a local agent worker surface');
      }
      if (options.localAgent) {
        authoredAgent = await attachLocalAgent(
          client, dataDir, options.onPtyReady, authoredRoot.localAgentStream,
        );
        authoredLlmClient = new JournalClient(socketPath);
        await authoredLlmClient.connect();
        await authoredLlmClient.hello('flows-authored-resume-llm');
        authoredLlm = new LlmWorker(authoredLlmClient, `${authoredAgent.stream}-llm`);
        await authoredLlm.attach();
      }
      const result = await resumeDurableAuthoredFlow(runId, client, {
        dataDir,
        localAgentStream: authoredAgent?.stream,
        lifecycle: options,
      });
      if (result === undefined) throw new Error('authored root disappeared during resume');
      return authoredCompletion('resume', base, socketPath, result, runId);
    }
    // resumeHelperEffect subsumes the old resumeSlackEffect: it handles the
    // slack effect resume plus every other provider from N's codegen. The
    // second call the earlier rebase left is a stale reference from before
    // the helper fanout renamed the API.
    let outcome = await client.runResume(runId, options.allowHumanInfluenced);
    if (await resumeHelperEffect(client, runId, dataDir)) {
      outcome = await client.runResume(runId, options.allowHumanInfluenced);
    }
    return await classifyOutcome(client, 'resume', outcome, base, socketPath, { ...options, dataDir });
  } catch (error) {
    if (error instanceof JournalProtocolError && error.code === 'human_influenced_run') {
      return { exitCode: 2, report: { ...base, runId, socketPath,
        diagnostics: [{ severity: 'refusal', kind: 'human_influenced_run', message: error.message.replace(/^human_influenced_run: /, '') }] } };
    }
    if (error instanceof AuthoredFlowExecutionError && error.code === 'unsupported_promise_lifecycle') {
      return { exitCode: 2, report: { ...base, runId, socketPath,
        diagnostics: [{ severity: 'refusal', kind: 'invalid_spec', message: error.message }] } };
    }
    if (error instanceof AuthoredFlowExecutionError
      && (error.code === 'helper_slack.credential_missing' || error.code === 'helper_slack.mount_required'
        || error.code === 'helper_provider.mount_required' || error.code === 'helper_provider.unsupported')) {
      return { exitCode: 2, report: { ...base, runId, socketPath,
        diagnostics: [{ severity: 'refusal', kind: error.code, message: error.message }] } };
    }
    // Same classification the run path gets. Resuming an authored root whose
    // `f.agent` step failed is a step failure, not a protocol failure, and
    // leaving it on `protocolFailure` meant `flows run` printed the evidence
    // while `flows resume` still printed `protocol_error` and
    // `RUN <id> unknown` for the identical failure.
    if (error instanceof AuthoredFlowExecutionError && (error.code === 'step_failed' || error.code === 'gate_failed')) {
      return authoredStepFailure('resume', base, socketPath, error, runId);
    }
    if (error instanceof AuthoredHumanParked) {
      return authoredHumanParked('resume', base, socketPath, error, { dataDir, localAgent: options.localAgent === true });
    }
    if (!(error instanceof JournalProtocolError) || error.code !== 'run_not_found') {
      return protocolFailure('resume', base, socketPath, error, runId);
    }
    return {
      exitCode: 2,
      report: {
        ...base,
        runId,
        socketPath,
        diagnostics: [{
          severity: 'refusal',
          kind: 'run_unavailable',
          message: `Run "${runId}" could not be resumed by relayflowd at "${socketPath}": ${errorMessage(error)}`,
        }],
      },
    };
  } finally {
    try {
      await authoredLlm?.close();
      authoredLlmClient?.close();
      await authoredAgent?.close();
    } finally {
      client.close();
    }
  }
}

/**
 * A step that ran and failed, reported as the run failure it is.
 *
 * Shared by `runDirectFlow` and `resumeFlow` on purpose. The first cut of this
 * fix classified the run path and left resume on `protocolFailure`, so `flows
 * run` became diagnosable while `flows resume` still printed `protocol_error`
 * and `RUN <id> unknown` for the same failed step — and the surface doc claimed
 * both were fixed. One function is what stops the two paths drifting again.
 *
 * `protocolFailure` is wrong here twice over: it blames the daemon for a run it
 * drove correctly, and it produces a report with no `status`, which is the
 * whole of what `RUN <id> unknown` ever meant.
 */
export function authoredStepFailure(
  command: RunCommand,
  base: CheckReport | RunReport,
  socketPath: string,
  error: AuthoredFlowExecutionError,
  fallbackRunId?: string,
): RunExecution {
  // The failing step runs as its own kernel run, so the error's run id is the
  // one whose journal holds the evidence. The resume target is the fallback.
  const runId = error.runId ?? fallbackRunId;
  return {
    exitCode: 1,
    report: {
      ...fromBase(command, base),
      ok: false,
      ...(runId === undefined ? {} : { runId }),
      socketPath,
      status: 'failed',
      completionReason: 'step_failed',
      diagnostics: [...base.diagnostics, {
        // The structured evidence the failing step left in its own journal.
        // `RunDiagnostic extends StepFailedDetails`, so `--json` gains the
        // fields it already declares instead of leaving them to be re-parsed
        // out of the rendered message.
        ...error.details,
        severity: 'failure',
        // A predicate gate that judged false is a run failure with its own
        // name, so the report says which kind of check the body did not pass.
        kind: error.code === 'gate_failed' ? 'gate_failed' : 'step_failed',
        // The `step_failed: ` prefix `AuthoredFlowExecutionError` adds is
        // redundant once the diagnostic is labelled `[step_failed]`.
        message: error.message.replace(/^(?:step_failed|gate_failed): /, ''),
      }],
    },
  };
}

/**
 * An authored body parked on an unanswered `f.human`: exit 3, like every
 * other park, but the diagnostic names the question, who it is for, and the
 * exact `flows answer` invocation — the run is waiting on a person, not on a
 * worker. Shared by `run` and `resume` so the two never drift.
 */
export function authoredHumanParked(
  command: RunCommand,
  base: CheckReport | RunReport,
  socketPath: string,
  error: AuthoredHumanParked,
  where: { dataDir?: string; localAgent: boolean },
): RunExecution {
  const runId = error.runId!;
  return {
    exitCode: 3,
    report: {
      ...fromBase(command, base),
      ok: false,
      runId,
      socketPath,
      status: 'parked',
      parkedStep: { id: 'authored-root', type: 'agent' },
      humanWait: { ...error.wait, recipient: parseHumanRecipient(error.wait.to) },
      diagnostics: [...base.diagnostics, {
        severity: 'parked',
        kind: 'run_parked',
        message: `Run "${runId}" is waiting for ${error.wait.to} to answer ${error.wait.waitId}: `
          + `${JSON.stringify(error.wait.question)}\n`
          + `Answer with: ${answerCommand(runId, error.wait.waitId, where.dataDir)}\n`
          + `Then continue with: ${resumeCommand(runId, where.dataDir, where.localAgent)}`,
      }],
    },
  };
}

/**
 * An authored body that returned its own terminal verdict, reported as that verdict.
 *
 * Shared by `runDirectFlow` and `resumeFlow` for the reason `authoredStepFailure`
 * is shared: the run and resume paths had already drifted once, and the
 * `needs_human` report was duplicated verbatim in both files.
 *
 * This is NOT `authoredStepFailure`, even though a `step_failed` verdict lands
 * on the same exit code and report shape. That function describes a step that
 * ran and failed, and carries the failing step's evidence. Here every step
 * succeeded and the BODY declared the outcome, so there is no failing step to
 * name — routing this through the other helper would invent one.
 */
export function authoredCompletion(
  command: RunCommand,
  base: RunReport,
  socketPath: string,
  result: { name: string; completionReason: LoweredCompletionReason; journalSteps: readonly unknown[] },
  runId: string | undefined,
): RunExecution {
  const common: RunReport = {
    ...fromBase(command, base),
    ...(runId === undefined ? {} : { runId }),
    socketPath,
    completedSteps: result.journalSteps.length,
  };
  switch (result.completionReason) {
    case 'success':
      return {
        exitCode: 0,
        report: { ...common, ok: true, status: 'completed', completionReason: 'success' },
      };
    case 'declined':
      return {
        exitCode: 0,
        report: {
          ...common, ok: true, status: 'completed', completionReason: 'success',
          diagnostics: [...base.diagnostics, {
            severity: 'declined', kind: 'run_declined',
            message: 'Flow deliberately chose not to act on this input.',
          }],
        },
      };
    case 'needs_human':
      return {
        exitCode: 3,
        report: {
          ...common, ok: false, status: 'parked',
          diagnostics: [...base.diagnostics, {
            severity: 'parked', kind: 'run_parked',
            message: `Flow "${result.name}" needs_human; see the journal for accumulated blockers.`,
          }],
        },
      };
    case 'step_failed':
      // A declared run failure. Exit 1, not the parked 3: nothing here is
      // waiting for a human to recover it, and exit 3 is the local kit's
      // manual-approval stop. `status: failed` with this `completionReason` is
      // also the only terminal shape Cloud accepts for a non-success run
      // (see cloud-run.ts).
      return {
        exitCode: 1,
        report: {
          ...common, ok: false, status: 'failed', completionReason: 'step_failed',
          diagnostics: [...base.diagnostics, {
            severity: 'failure', kind: 'step_failed',
            message: `Flow "${result.name}" declared done("step_failed"): its own checks did not pass. `
              + 'No step failed, so there is no step-level evidence to inspect; the journal holds '
              + 'every step the flow ran before it decided.',
          }],
        },
      };
  }
  // Exhaustive by construction. A new lowered completion has to choose its
  // own exit code and wording here; it must not inherit "its own checks did not
  // pass", which would state something the body never declared. Letting an
  // unlisted reason fall through to the failure branch is how a reporting-side
  // copy of the same vocabulary drifts from the executor's — the defect this
  // change exists to close — so it is a compile error, not a wrong report.
  const unreachable: never = result.completionReason;
  throw new Error(`unreachable authored completion: ${String(unreachable)}`);
}

/**
 * Get a live daemon, then open the socket to it.
 *
 * This is the single seam every journal-opening verb shares (`runFlow`,
 * `resumeFlow`, `runDirectFlow`), and it is where attach-or-spawn belongs —
 * *after* the command has compiled, preflighted and validated its input, and
 * immediately before `JournalClient` is used. Hoisting it into `runCli`
 * instead would make a malformed invocation start a daemon as a side effect,
 * breaking the surface's promise that missing, invalid, and oversized input is
 * refused before the CLI contacts relayflowd (docs/SURFACE.md §5).
 *
 * Everything past `ensureDaemon` is unchanged and still fails closed: a
 * connect or `hello` that fails against a daemon we just attached to is a
 * refusal, with no retry and no second spawn.
 */
export async function connect(
  client: JournalClient,
  command: RunCommand,
  dataDir: string,
  base: RunReport,
  options: RunLifecycleOptions = {},
): Promise<RunExecution | undefined> {
  const socketPath = socketFor(dataDir);
  const daemon = await ensureDaemon(dataDir, options.daemon ?? {});
  if (daemon.kind !== 'attached') {
    client.close();
    return {
      exitCode: 2,
      report: {
        ...fromBase(command, base),
        socketPath,
        diagnostics: [...base.diagnostics, daemonRefusal(daemon, dataDir, socketPath)],
      },
    };
  }
  if (daemon.warning !== undefined) {
    // `base.diagnostics` is the accumulator that becomes the report's
    // diagnostics, so a warning raised while attaching belongs in it — the
    // attach succeeded, and silence about an anomaly is what AGENTS.md rule 4
    // forbids.
    base.diagnostics.push({
      severity: 'warning',
      kind: 'connection_file_stale',
      message: daemon.warning,
    });
  }

  try {
    await client.connect();
  } catch {
    client.close();
    return {
      exitCode: 2,
      report: {
        ...fromBase(command, base),
        socketPath,
        diagnostics: [
          ...base.diagnostics,
          {
            severity: 'refusal',
            kind: 'daemon_unreachable',
            message: `No compatible relayflowd is listening at "${socketPath}". Start it with: relayflowd --data-dir ${JSON.stringify(dataDir)} serve`,
          },
        ],
      },
    };
  }
  try {
    await client.hello(`flows-${command}`);
    return undefined;
  } catch (error) {
    client.close();
    return protocolFailure(command, base, socketPath, error);
  }
}

/// Exported for tests. The `running`-with-no-identifiable-step branch (#179)
/// only occurs in a sub-second window against a live daemon, so pinning it
/// needs a stubbed client rather than a real run -- the integration test that
/// found it reproduced the bug roughly 1 time in 12.
export async function classifyOutcome(
  client: JournalClient,
  command: RunCommand,
  outcome: RunOutcome,
  base: CheckReport | RunReport,
  socketPath: string,
  options: RunLifecycleOptions,
): Promise<RunExecution> {
  let current = outcome;
  let parkedStep: ParkedStep | undefined;
  let needsHuman = false;
  let unclassifiedPolls = 0;
  while (current.status === 'parked') {
    const inspection = await inspectOutOfBandStep(client, current.run_id);
    if (inspection?.parkedStep !== undefined) {
      parkedStep = inspection.parkedStep;
      needsHuman = inspection.needsHuman;
      break;
    }
    if (inspection?.runningStep !== undefined) {
      await waitForRunningStep(client, current.run_id, inspection.runningStep, options);
      current = await client.runResume(current.run_id, command === 'run' || options.allowHumanInfluenced);
      continue;
    }
    if (inspection?.status === 'completed' || inspection?.status === 'failed') {
      current = await client.runResume(current.run_id, command === 'run' || options.allowHumanInfluenced);
      continue;
    }
    // The run is still RUNNING but no step is identifiable at this instant.
    //
    // That is a healthy state, not a protocol error. It happens when a worker
    // has just completed the step this run parked on and the daemon has not yet
    // finished driving what follows: nothing is `needs_human`, `runnable` or
    // `running` for a moment, while the snapshot's own status is `running`.
    // Breaking here left `status === 'parked'` with no `parkedStep`, so the
    // tail reported `parked without a classifiable completion` -- a spurious
    // failure on a run that was about to succeed (#179). Reproduced 1 in 4-15
    // locally; the probe that caught it printed
    // `inspection={"status":"running","needsHuman":false}`.
    //
    // So poll it, bounded. Resuming immediately would spin, since the daemon
    // needs a moment to advance.
    if (inspection?.status === 'running' && unclassifiedPolls < MAX_UNCLASSIFIED_POLLS) {
      unclassifiedPolls += 1;
      // `delay(ms, signal)`, not a bare setTimeout: every other wait in this
      // file is cancel-aware, and an uncancellable one here would keep polling
      // the daemon for up to 2s after a Ctrl-C or a lifecycle abort.
      throwIfCanceled(options.signal, current.run_id);
      await delay(UNCLASSIFIED_POLL_MS, options.signal);
      // Redundant resumes are safe: `run.resume` is idempotent on a run that
      // is already progressing -- it returns the current state rather than
      // re-dispatching. This loop leans on that up to MAX_UNCLASSIFIED_POLLS
      // times while the daemon is mid-transition.
      current = await client.runResume(current.run_id, command === 'run' || options.allowHumanInfluenced);
      continue;
    }
    // Fail closed rather than loop forever: if it never resolves, the original
    // error below still fires and says so.
    break;
  }

  const report: RunReport = {
    ...fromBase(command, base),
    ok: current.status === 'completed' && current.completion_reason === 'success',
    runId: current.run_id,
    socketPath,
    status: current.status,
    ...(current.completion_reason !== null ? { completionReason: current.completion_reason } : {}),
    completedSteps: current.completed_steps,
  };

  if (report.ok) return { exitCode: 0, report };
  if (current.status === 'failed' && current.completion_reason !== null) {
    const diagnostic: RunDiagnostic = {
      severity: 'failure',
      kind: current.completion_reason,
      message: `Run "${current.run_id}" failed with completionReason: ${current.completion_reason}.`,
    };
    if (current.completion_reason === 'step_failed') {
      let details: StepFailedDetails | undefined;
      try {
        details = await stepFailureDetails(client, current.run_id);
      } catch (error) {
        // Inspection must not erase the already known run failure.
        diagnostic.message += ` Could not inspect the failed step: ${errorMessage(error)}`;
      }
      if (details !== undefined) {
        Object.assign(diagnostic, details);
        diagnostic.message += renderStepEvidence(details);
      }
      // Appended whatever the inspection found — including nothing. A failure
      // shape this reader does not recognise, or a journal it could not read,
      // must still end with somewhere to go rather than with a dead end.
      const where = inspectionHint(current.run_id, details?.stepId, options.dataDir);
      Object.assign(diagnostic, where);
      diagnostic.message += renderInspection(where);
    }
    return {
      exitCode: 1,
      report: {
        ...report,
        diagnostics: [...report.diagnostics, diagnostic],
      },
    };
  }
  if (current.status === 'parked' && parkedStep !== undefined) {
    return {
      exitCode: 3,
      report: {
        ...report,
        parkedStep,
        diagnostics: [...report.diagnostics, {
          severity: 'parked',
          kind: 'run_parked',
          message: needsHuman
            ? `Run "${current.run_id}" parked at step "${parkedStep.id}" (${parkedStep.type}): waiting for human recovery after the worker attempt failed.`
            : `Run "${current.run_id}" parked at step "${parkedStep.id}" (${parkedStep.type}): no worker is attached for step type "${parkedStep.type}".`
              // Only suggest the `--local-agent` remedy for YAML flows.
              // Authored TS flows require `--input`; the bare command below
              // would be refused (Cursor Bugbot flagged as LOW on flows#293).
              // For TS we omit the hint rather than fabricate a syntactically
              // valid but semantically wrong command — the direct-run refusal
              // for TS already names its own missing --input.
              + (command === 'run'
                  && parkedStep.type === 'agent'
                  && !options.localAgent
                  && base.path !== undefined
                  && !isAuthoredFlowPath(base.path)
                ? ` To start a new run with a local agent worker: flows run --local-agent '${base.path.replace(/'/g, "'\\''")}'. Declared workspace or stream surfaces require a worker that holds their pins.`
                : ''),
        }],
      },
    };
  }
  return protocolFailure(command, base, socketPath, new Error(
    `relayflowd returned status ${current.status} without a classifiable completion`,
  ), current.run_id);
}

interface OutOfBandInspection {
  status: RunStatus;
  parkedStep?: ParkedStep;
  needsHuman: boolean;
  runningStep?: RunningStep;
}

interface RunningStep extends ParkedStep {
  leaseDeadlineMs: number;
}

// Bound on re-polling a run that reports `running` with no identifiable step.
// 40 x 50ms = 2s, far longer than the sub-second window observed in #179, and
// short enough that a genuinely stuck run still reports rather than hangs.
const MAX_UNCLASSIFIED_POLLS = 40;
const UNCLASSIFIED_POLL_MS = 50;

async function inspectOutOfBandStep(
  client: JournalClient,
  runId: string,
): Promise<OutOfBandInspection | undefined> {
  const snapshot = await client.runGet(runId);
  const entries = Object.entries(snapshot.steps);
  const humanEntry = entries.find(([, step]) =>
    step.type !== 'deterministic' && step.state === 'needs_human',
  );
  const runnableEntry = entries.find(([, step]) =>
    step.type !== 'deterministic' && step.state === 'runnable',
  );
  const runningEntry = entries.find(([, step]) =>
    step.type !== 'deterministic' && step.state === 'running',
  );
  const parkedEntry = humanEntry ?? runnableEntry;
  const parkedStep = parkedEntry === undefined ? undefined : {
    id: parkedEntry[0],
    type: parkedEntry[1].type as Extract<StepType, 'llm' | 'agent'>,
  };
  const runningStep = runningEntry === undefined ? undefined : {
    id: runningEntry[0],
    type: runningEntry[1].type as Extract<StepType, 'llm' | 'agent'>,
    leaseDeadlineMs: runningEntry[1].lease_deadline_ms ?? Number.NaN,
  };
  return {
    status: snapshot.status,
    needsHuman: humanEntry !== undefined,
    ...(parkedStep !== undefined ? { parkedStep } : {}),
    ...(runningStep !== undefined ? { runningStep } : {}),
  };
}

async function waitForRunningStep(
  client: JournalClient,
  runId: string,
  runningStep: RunningStep,
  options: RunLifecycleOptions,
): Promise<void> {
  let leaseDeadlineMs = runningStep.leaseDeadlineMs;
  if (!Number.isFinite(leaseDeadlineMs)) {
    throw new Error(`running step "${runningStep.id}" omitted lease_deadline_ms`);
  }
  options.onWait?.({
    runId,
    stepId: runningStep.id,
    stepType: runningStep.type,
    leaseDeadlineMs,
  });
  while (true) {
    throwIfCanceled(options.signal, runningStep.id);
    const remainingMs = leaseDeadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `worker lease for step "${runningStep.id}" expired at ${leaseDeadlineMs} without completion`,
      );
    }
    await delay(Math.min(50, remainingMs), options.signal);
    const snapshot = await client.runGet(runId);
    const step = snapshot.steps[runningStep.id];
    if (step?.state !== 'running') return;
    if (step.lease_deadline_ms !== undefined && step.lease_deadline_ms !== leaseDeadlineMs) {
      leaseDeadlineMs = step.lease_deadline_ms;
      options.onWait?.({
        runId,
        stepId: runningStep.id,
        stepType: runningStep.type,
        leaseDeadlineMs,
      });
    }
  }
}

export function protocolFailure(
  command: RunCommand,
  base: CheckReport | RunReport,
  socketPath: string,
  error: unknown,
  runId?: string,
): RunExecution {
  return {
    exitCode: 1,
    report: {
      ...fromBase(command, base),
      ...(runId !== undefined ? { runId } : {}),
      socketPath,
      diagnostics: [...base.diagnostics, {
        severity: 'failure',
        kind: 'protocol_error',
        message: `relayflowd could not complete the ${command} request: ${errorMessage(error)}`,
      }],
    },
  };
}

export function fromCheckReport(command: RunCommand, report: CheckReport): RunReport {
  return {
    ok: false,
    command,
    ...(report.path !== undefined ? { path: report.path } : {}),
    ...(report.projectConfigPath !== undefined ? { projectConfigPath: report.projectConfigPath } : {}),
    resolutions: report.resolutions,
    // Copied, not aliased: the returned report is an accumulator the attach
    // step appends to, and it must not write back into the check report.
    diagnostics: [...report.diagnostics],
  };
}

export function emptyReport(command: RunCommand): RunReport {
  return { ok: false, command, resolutions: [], diagnostics: [] };
}

function fromBase(command: RunCommand, base: CheckReport | RunReport): RunReport {
  return 'command' in base ? base : fromCheckReport(command, base);
}

// Delegates to the daemon-connection derivation so run.ts, direct-run.ts, and
// the daemon-lifecycle attach path all speak the same socket path. Kept as a
// re-export here so existing callers do not have to reach into
// daemon-connection.ts. See socketPathFor for the SUN_LEN reasoning (#262).
export function socketFor(dataDir: string): string {
  return socketPathFor(dataDir);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown protocol error';
}

function throwIfCanceled(signal: AbortSignal | undefined, stepId: string): void {
  if (signal?.aborted === true) throw new Error(`waiting for running step "${stepId}" was canceled`);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    const finish = (): void => {
      signal?.removeEventListener('abort', cancel);
      resolveDelay();
    };
    const timer = setTimeout(finish, ms);
    if (signal === undefined) return;
    const cancel = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      rejectDelay(new Error('worker wait canceled'));
    };
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  });
}
