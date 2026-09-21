#!/usr/bin/env node
import { addPlugin } from './cli/add.js';
import { parsePluginArgs, runPluginCommand, type PluginArgs } from './cli/plugin.js';
import { watchCheck } from './cli-watch.js';
import { checkHelperBody } from './cli/check-helper-body.js';
import { describeFlowRequirements } from './flow-requirements.js';

import { renderProgress, type ProgressEvent } from './progress.js';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  checkFlow,
  inputFailureReport,
  type CheckReport,
} from './cli/check.js';
import {
  resumeFlow,
  runFlow,
  type RunExecution,
  type RunProgress,
  type RunReport,
} from './cli/run.js';
import { answerFlow } from './cli/answer.js';
import { checkAuthoredTriggers } from './cli/check-triggers.js';
import { parseWebhookArgs, runServeWebhook } from './cli/serve-webhook.js';
import { runDirectFlow } from './cli/direct-run.js';
import { parseReplayArgs, replayJournal, type ReplayArgs } from './cli/replay.js';
import { parseStatusArgs, runStatus, type StatusArgs } from './cli/status.js';
import {
  parseLogsArgs, parseRunsArgs, runCloudLogsCli, runCloudRunsCli, runCloudStatusCli,
  type LogsArgs, type RunsArgs,
} from './cli/cloud-read.js';
import { transcriptTailSource } from './transcript-tail.js';
import { checkTypeScriptFlow } from './cli/check-typescript.js';
import { runCloudCli } from './cli/cloud-run.js';
import { runCloudSyncCli } from './cli/cloud-sync.js';
import { parseCloudDeployArgs, runCloudDeployCli, runCloudDeploymentsCli, runCloudUndeployCli, type CloudDeployArgs } from './cli/cloud-deploy.js';
import { parseCloudScheduleArgs, runCloudScheduleCli, runCloudSchedulesCli, runCloudUnscheduleCli, type CloudScheduleArgs } from './cli/cloud-schedule.js';
import { isAuthoredFlowPath } from './direct-input.js';
import { parseDeployArgs, runDeploy, type DeployArgs } from './cli/deploy.js';
import { parseDigestReference } from './bundle-transport.js';
import { parseBuildArgs, runBuild, type BuildArgs } from './cli/build.js';
import { runHnMonitor } from './cli/hn-monitor.js';
import { runTickRunner } from './cli/tick-runner.js';
import { DEFAULT_DATA_DIR } from './daemon-connection.js';
import { CLI_VERB_NAMES } from './cli-commands.js';
import {
  mintObserverUrl,
  resolveObserverLinkEnv,
  type MintObserverOptions,
} from './observer-link.js';

export type { CheckInputDiagnostic, CheckReport } from './cli/check.js';

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

type CliExitCode = 0 | 1 | 2 | 3;

/**
 * Every shape `parseArgs` can produce. Exported for `cli-commands.ts`, whose
 * table must claim each variant or fail to compile.
 */
export type ParsedArgs =
  | { command: 'add'; value: string }
  | PluginArgs
  | ReplayArgs
  | StatusArgs
  | BuildArgs
  | DeployArgs
  | { command: 'serve-webhook'; dataDir: string; port: number; admitted?: readonly string[] }
  | { command: 'cloud-run'; value: string; json: boolean; wait: boolean; input: string | undefined; syncCode: boolean; noConnect: boolean }
  | { command: 'sync'; runId: string; json: boolean; root: string; dryRun: boolean }
  | CloudDeployArgs
  | { command: 'deployments'; json: boolean }
  | { command: 'undeploy'; agentId: string; json: boolean }
  | CloudScheduleArgs
  | { command: 'schedules'; json: boolean }
  | { command: 'unschedule'; scheduleId: string; json: boolean }
  | { command: 'check'; json: boolean; watch: boolean; value: string }
  | { command: 'run'; bucket: string | undefined; reuseFromRunId: string | undefined; localAgent: boolean; dataDir: string; input: string | undefined; json: boolean; spawn: boolean; noObserverLink: boolean; allowHumanInfluenced: boolean; value: string }
  | { command: 'resume'; localAgent: boolean; dataDir: string; json: boolean; spawn: boolean; noObserverLink: boolean; allowHumanInfluenced: boolean; value: string }
  | { command: 'answer'; dataDir: string; json: boolean; spawn: boolean; note: string | undefined; by: string | undefined; runId: string; waitId: string; answer: boolean }
  | RunsArgs
  | LogsArgs
  | { command: 'observer'; dataDir: string }
  | { command: 'hn-monitor'; sub: 'start'; dataDir: string; specPath: string; pollIntervalMs: number | undefined }
  | { command: 'tick'; sub: 'start'; dataDir: string; specPath: string; scheduleId: string;
      intervalMs: number; epochMs: number | undefined; maxCatchUp: number | undefined;
      pollIntervalMs: number | undefined };

const USAGE = [
  'Usage:',
  'flows add <helper-name|@flows/helper-name>',
  'flows add <github:owner/repo@ref#path|https://github.com/owner/repo/tree/ref/path>',
  'flows plugin list [--json]',
  'flows plugin verify [--json] [--offline]',
  'flows plugin remove [--json] <name>',
  'flows plugin update [--json] [--yes] [--to <ref>] [<name>]',
  'flows build [--out <dir>] <flow.yaml|flow.ts>',
  'flows build --verify <bundle-dir>',
  'flows deploy <flow.ts> --repo <owner/name> --on <provider>[:key=value,...] [--on ...] --approver <handle> [--agents claude[,codex]] [--name <name>] [--draft] [--plugin <ref>] [--no-connect] [--json]',
  'flows deployments [--json]',
  'flows undeploy [--json] <deployment-id>',
  'flows schedule <flow.yaml|flow.ts> [--cron "<expr>" | --every <n><s|m|h|d>] [--tz <IANA>] [--input <inline-json-or-file>] [--name <name>] [--no-connect] [--json]',
  'flows schedules [--json]',
  'flows unschedule [--json] <schedule-id>',
  'flows deploy <flow>@sha256:<digest> --to <file-bucket-uri>',
  'flows run <flow>@sha256:<digest> [--bucket <file-bucket-uri>] [--data-dir <dir>] [--json]',
  'flows check [--watch] [--json] <flow.ts|flow.yaml|spec.json>',
  'flows serve-webhook --data-dir <dir> --port <p> [--allow <name>[,<name>]]',
  'flows run [--json] [--no-spawn] [--no-observer-link] [--data-dir <dir>] [--local-agent] [--reuse-from <run-id>] <flow.yaml|spec.json>',
  'flows run --cloud [--json] [--wait] [--sync-code] [--no-connect] <flow.yaml|spec.json>',
  'flows run --cloud [--json] [--wait] [--sync-code] [--no-connect] <flow.ts> --input <inline-json-or-file>',
  'flows sync [--json] [--dry-run] [--dir <path>] <run-id>',
  'flows run [--json] [--no-spawn] [--no-observer-link] [--data-dir <dir>] [--local-agent] <flow.ts> --input <inline-json-or-file>',
  'flows tick start --schedule-id <id> --interval-ms <ms> [--epoch-ms <ms>] [--max-catch-up <n>] [--poll-interval-ms <ms>] [--data-dir <dir>] <spec.json>',
  'flows resume [--allow-human-influenced] [--json] [--no-spawn] [--no-observer-link] [--data-dir <dir>] [--local-agent] <run-id>',
  'flows answer [--json] [--no-spawn] [--data-dir <dir>] [--note <text>] [--by <identity>] <run-id> <wait-id> <yes|no>',
  'flows replay [--allow-human-influenced] [--json] [--data-dir <dir>] <run-id> [--at <step-id>]',
  'flows status [--json] [--data-dir <dir>] [--tail <n>] [<run-id>]',
  'flows status --cloud [--json] <run-id>',
  'flows runs [--limit <n>] [--json]',
  'flows logs [--step <name>] [--raw] [--json] <run-id>',
  'flows observer [--data-dir <dir>]',
  'flows hn-monitor start [--data-dir <dir>] [--poll-interval-ms <n>] <spec.json>',
].join('\n');

/**
 * `FLOWS_NO_SPAWN=1` is `--no-spawn` for a whole environment: the lever for CI
 * that means to assert a daemon is already present rather than conjure one
 * (kernel/DAEMON-LIFECYCLE.md §4). Only the exact string `1` counts — an
 * unset or empty variable must not be read as an opinion.
 */
function spawnAllowedByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['FLOWS_NO_SPAWN'] !== '1';
}

const PROCESS_IO: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

/** Optional knobs for an embedded caller. `bin/flows.js` passes none. */
export interface RunCliOptions {
  /**
   * Cancellation for the long-running verbs (`run --cloud`, `check --watch`,
   * `serve-webhook`, `hn-monitor start`, `tick start`).
   *
   * Supply one and `runCli` installs **no** process signal handlers -- required
   * of a CLI surface mounted into another host, which owns SIGINT itself.
   * Omit it and the standalone `flows` binary keeps today's behaviour exactly:
   * SIGINT/SIGTERM are handled here, for the duration of that verb only.
   */
  signal?: AbortSignal;
}

/**
 * Run one long-running verb under a cancellation signal.
 *
 * With a caller-supplied signal this installs nothing. Without one it owns
 * SIGINT/SIGTERM for the duration of `body` and removes the handlers after --
 * the pre-existing standalone behaviour, unchanged.
 */
async function withInterrupt<T>(
  provided: AbortSignal | undefined,
  body: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (provided !== undefined) return body(provided);
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    return await body(controller.signal);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

export async function runCli(
  args: readonly string[],
  io: CliIo = PROCESS_IO,
  options: RunCliOptions = {},
): Promise<CliExitCode> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    io.stdout(USAGE);
    return 0;
  }

  const parsed = parseArgs(args);
  if (parsed === undefined) {
    const report = inputFailureReport({ kind: 'invalid_invocation', message: USAGE });
    emitCheckReport(report, args.includes('--json'), io);
    return 2;
  }

  if (parsed.command === 'add') return addPlugin(parsed.value, io);
  if (parsed.command === 'plugin') return runPluginCommand(parsed, io);

  if (parsed.command === 'serve-webhook') {
    return withInterrupt(options.signal, (signal) => runServeWebhook(parsed, io, signal));
  }

  if (parsed.command === 'cloud-run') {
    return withInterrupt(options.signal, (signal) => runCloudCli(parsed, io, signal));
  }
  if (parsed.command === 'sync') return runCloudSyncCli(parsed, io);
  if (parsed.command === 'cloud-deploy') return runCloudDeployCli(parsed, io);
  if (parsed.command === 'deployments') return runCloudDeploymentsCli(parsed, io);
  if (parsed.command === 'undeploy') return runCloudUndeployCli(parsed, io);
  if (parsed.command === 'schedule') return runCloudScheduleCli(parsed, io);
  if (parsed.command === 'schedules') return runCloudSchedulesCli(parsed, io);
  if (parsed.command === 'unschedule') return runCloudUnscheduleCli(parsed, io);
  if (parsed.command === 'replay') return replayJournal(parsed, io);
  // Daemon-free like `check`: reads one journal file and nothing else, so it
  // works inside a step of a run whose daemon is gone (kernel/DAEMON-LIFECYCLE.md §4).
  if (parsed.command === 'status') {
    // One verb, two sources. `--cloud` never reaches `runStatus`, so the
    // offline reader stays offline (cli/status.ts).
    return parsed.cloud === true
      ? runCloudStatusCli(parsed, io)
      : runStatus(parsed, io, { tails: transcriptTailSource() });
  }
  if (parsed.command === 'runs') return runCloudRunsCli(parsed, io);
  if (parsed.command === 'logs') return runCloudLogsCli(parsed, io);
  if (parsed.command === 'answer') {
    const execution = await answerFlow(parsed.runId, parsed.waitId, parsed.answer, parsed.dataDir, {
      ...(parsed.note === undefined ? {} : { note: parsed.note }),
      ...(parsed.by === undefined ? {} : { answeredBy: parsed.by }),
      daemon: { spawn: parsed.spawn && spawnAllowedByEnv() },
    });
    emitRunReport(execution, parsed.json, io);
    return execution.exitCode;
  }
  if (parsed.command === 'build') return runBuild(parsed, io);
  if (parsed.command === 'deploy') return runDeploy(parsed, io);

  if (parsed.command === 'check') {
    if (parsed.watch) {
      return withInterrupt(options.signal, (signal) => watchCheck(parsed.value, parsed.json, io, signal));
    }
    // Deliberately daemon-free (kernel/DAEMON-LIFECYCLE.md §4). `checkFlow` is
    // a compile-and-preflight that opens no daemon socket, and the parser
    // refuses `--data-dir` on `check`, so there is no data dir to attach to.
    // `flows check` keeps working with no daemon, no relayflowd binary and no
    // data directory at all -- a property worth keeping, not an omission.
    const checked = /\.(?:[cm]?[jt]s)$/.test(parsed.value)
      ? await checkAuthoredFlowComposed(parsed.value) : checkFlow(parsed.value);
    emitCheckReport(checked.report, parsed.json, io);
    return checked.report.ok ? 0 : 2;
  }

  if (parsed.command === 'observer') return runObserverCommand(io);

  if (parsed.command === 'hn-monitor') {
    return withInterrupt(options.signal, (signal) => runHnMonitor({
      dataDir: parsed.dataDir,
      specPath: parsed.specPath,
      pollIntervalMs: parsed.pollIntervalMs,
      signal,
    }, io));
  }

  if (parsed.command === 'tick') {
    return withInterrupt(options.signal, async (signal) => await runTickRunner({
      dataDir: parsed.dataDir,
      specPath: parsed.specPath,
      schedule: {
        scheduleId: parsed.scheduleId,
        intervalMs: parsed.intervalMs,
        ...(parsed.epochMs === undefined ? {} : { epochMs: parsed.epochMs }),
        ...(parsed.maxCatchUp === undefined ? {} : { maxCatchUp: parsed.maxCatchUp }),
      },
      pollIntervalMs: parsed.pollIntervalMs,
      signal,
    }, io) as CliExitCode);
  }

  // Attach-or-spawn runs inside `runFlow`/`resumeFlow`/`runDirectFlow`, at the
  // single `connect()` seam immediately before journal-client.ts is used --
  // not here. Hoisting it above the dispatch would start a daemon as a side
  // effect of an invocation that is about to be refused for bad input.
  const startedSteps = new Map<string, number>();
  const showProgress = (event: ProgressEvent): void => {
    if (event.type === 'step.started') startedSteps.set(event.stepId, performance.now());
    if (!parsed.json) for (const line of renderProgress([event])) io.stderr(line);
  };
  const lifecycle = {
    ...(parsed.command === 'run' ? { bucket: parsed.bucket } : {}),
    allowHumanInfluenced: parsed.allowHumanInfluenced,
    onPtyReady: (path: string) => io.stderr(`PTY ${path}`),
    ...(parsed.command === 'run' && parsed.reuseFromRunId !== undefined ? { reuseFromRunId: parsed.reuseFromRunId } : {}),
    localAgent: parsed.localAgent,
    onProgress: showProgress,
    onWait: (progress: RunProgress) => {
      emitWait(progress, io);
      const now = performance.now();
      if (!startedSteps.has(progress.stepId)) startedSteps.set(progress.stepId, now);
      showProgress({ type: 'step.running', stepId: progress.stepId, stepType: progress.stepType,
        elapsedMs: now - startedSteps.get(progress.stepId)! });
    },
    daemon: { spawn: parsed.spawn && spawnAllowedByEnv() },
  };
  // Mint the observer token in parallel with the run so the mint round-trip
  // never adds to the RUN summary latency. The outcome is only consulted at
  // emit time; a rejected promise here can never fail the run (see
  // `observerUrlFrom`, which swallows every failure into `warning`).
  const observerMint = startObserverMint(parsed);
  const execution = parsed.command === 'run'
    ? isAuthoredFlowPath(parsed.value)
      ? await runDirectFlow(parsed.value, parsed.input, parsed.dataDir, lifecycle)
      : await runFlow(parsed.value, parsed.dataDir, lifecycle)
    : await resumeFlow(parsed.value, parsed.dataDir, lifecycle);
  // In `--json` mode the report is a single machine-readable object that
  // MUST carry `observerUrl` when one is available, so a consumer sees one
  // authoritative signal. That justifies blocking up to `MINT_TIMEOUT_MS`
  // on the mint before emit -- consumers can wait for a bounded time.
  //
  // In plain-text mode the `RUN` line and any check diagnostics carry the
  // primary signal; the observer URL is a nice-to-have follow-up. Blocking
  // the RUN summary on a stalled Relaycast call (up to 5s per failed
  // preflight) is worse than printing `Observer:` on a later line, so we
  // emit the run report immediately and finalize the observer link after.
  if (parsed.json) {
    const observerUrl = await observerUrlFrom(observerMint, io);
    emitRunReport(execution, parsed.json, io, observerUrl);
    return execution.exitCode;
  }
  emitRunReport(execution, parsed.json, io);
  await finalizeObserverLine(observerMint, io);
  return execution.exitCode;
}

/**
 * Compose helper-body checks (from f.slack aspect) with TS-flow MCP checks
 * so an authored .flow.ts surfaces diagnostics from both. Both check
 * functions load the authored flow independently — this can be flattened
 * later, but composing them keeps the rebase minimal and preserves both
 * aspects' coverage.
 */
async function checkAuthoredFlowComposed(path: string): Promise<{ report: CheckReport }> {
  const helper = await checkHelperBody(path);
  if (!helper.report.ok) return helper;
  const mcp = await checkTypeScriptFlow(path);
  const triggers = isAuthoredFlowPath(path)
    ? await checkAuthoredTriggers(path)
    : undefined;
  const triggerDiagnostics = triggers?.report.diagnostics ?? [];
  const triggerOk = triggers?.report.ok ?? true;
  return {
    report: {
      ...mcp.report,
      ...(triggers?.report.schedules === undefined ? {} : { schedules: triggers.report.schedules }),
      ...(triggers?.report.extensions === undefined ? {} : { extensions: triggers.report.extensions }),
      ...(triggers?.report.hooks === undefined ? {} : { hooks: triggers.report.hooks }),
      // The authored definition sees helper flags, body use and `cli:`
      // declarations; the compiled view underneath knows only its steps.
      ...(triggers?.report.requirements === undefined ? {} : { requirements: triggers.report.requirements }),
      diagnostics: [...helper.report.diagnostics, ...mcp.report.diagnostics, ...triggerDiagnostics],
      ok: helper.report.ok && mcp.report.ok && triggerOk,
    },
  };
}

/**
 * Start the observer-token mint if the environment says one should happen.
 * Returns `undefined` when no attempt should be made — no workspace key
 * configured, or `FLOWS_NO_OBSERVER=1` / `--no-observer-link` — which is the
 * silent-skip branch. The returned promise always resolves; a rejection here
 * would slip past `observerUrlFrom` and could fail the run, which the feature
 * expressly forbids.
 */
function startObserverMint(
  parsed: { command: 'run' | 'resume'; noObserverLink: boolean },
  env: NodeJS.ProcessEnv = process.env,
  mint: (options: MintObserverOptions) => Promise<{ observerUrl?: string; warning?: string }> = mintObserverUrl,
): Promise<{ observerUrl?: string; warning?: string }> | undefined {
  if (parsed.noObserverLink) return undefined;
  // `resolveObserverLinkEnv` (not `readObserverLinkEnv`) falls back to the
  // `agent-relay cloud login` workspace store (~/.agentworkforce/relay/
  // workspaces.json) when RELAYCAST_WORKSPACE_KEY is unset. Env wins if set;
  // FLOWS_NO_OBSERVER=1 still suppresses regardless of source.
  const link = resolveObserverLinkEnv(env);
  if (link.suppressed || link.workspaceKey === undefined) return undefined;
  return mint({
    workspaceKey: link.workspaceKey,
    ...(link.baseUrl !== undefined ? { baseUrl: link.baseUrl } : {}),
    ...(link.dashboardUrl !== undefined ? { dashboardUrl: link.dashboardUrl } : {}),
  }).catch((error) => ({
    warning: error instanceof Error ? error.message : 'unknown mint error',
  }));
}

/**
 * Resolve the pending observer-mint into a URL (or nothing), and route any
 * mint warning to stderr under a `[observer]` label. Silent-skip (`undefined`
 * input) prints nothing at all, so a workspace with no observer configured
 * produces no observer output on stderr or stdout.
 */
async function observerUrlFrom(
  mint: Promise<{ observerUrl?: string; warning?: string }> | undefined,
  io: CliIo,
): Promise<string | undefined> {
  if (mint === undefined) return undefined;
  const outcome = await mint;
  if (outcome.warning !== undefined) {
    io.stderr(`[observer] token mint failed: ${outcome.warning}; continuing without an observer link (the run is unaffected)`);
  }
  return outcome.observerUrl;
}

/**
 * Grace budget the plain-text emit path waits for a still-pending mint after
 * the RUN summary is out. `mintObserverUrl` already caps its own network
 * round-trip at `MINT_TIMEOUT_MS` (5s). The grace matches that ceiling so a
 * slow-but-legitimate mint (empirically ~1.6s cold against
 * `cast.agentrelay.com`) is not clipped by a shorter grace. A mint that has
 * not resolved by 5s is genuinely stuck.
 */
const OBSERVER_FINALIZE_GRACE_MS = 5_000;

/**
 * Finalize the plain-text observer line after the RUN summary is already on
 * stdout. If the mint resolves in time, print `Observer: <url>` on its own
 * stdout line (matching v1 relayflows' convention). If it fails, print the
 * standard `[observer]` diagnostic on stderr. If it is still pending after
 * `OBSERVER_FINALIZE_GRACE_MS`, print a distinct stderr line so the operator
 * knows the mint did not complete rather than seeing silence -- and stop
 * waiting so the CLI can exit.
 */
/**
 * `flows observer`: mint and print a single observer URL. Reuses the same
 * env parsing (`readObserverLinkEnv`) and mint (`mintObserverUrl`) as the
 * run/resume verbs, so an operator who already has an observer URL working
 * via `flows run` will get the identical URL shape here. Every failure
 * path -- unset key, suppressed via `FLOWS_NO_OBSERVER`, mint HTTP error,
 * network error, malformed response -- is refused with `REFUSED
 * [observer_link_unavailable] <reason>` on stderr and exit 2, matching the
 * flows CLI refusal shape (see `parseArgs` -> `invalid_invocation`).
 */
async function runObserverCommand(
  io: CliIo,
  env: NodeJS.ProcessEnv = process.env,
  mint: (options: MintObserverOptions) => Promise<{ observerUrl?: string; warning?: string }> = mintObserverUrl,
): Promise<CliExitCode> {
  // Same resolution as `flows run`: env wins, then the `agent-relay cloud
  // login` workspace store. The refusal message names the env var because
  // that is the primary path an operator is expected to configure; the
  // cloud-login fallback is convenience, not the documented contract.
  const link = resolveObserverLinkEnv(env);
  if (link.suppressed) {
    io.stderr('REFUSED [observer_link_unavailable] mint suppressed by FLOWS_NO_OBSERVER=1');
    return 2;
  }
  if (link.workspaceKey === undefined) {
    io.stderr(
      'REFUSED [observer_link_unavailable] no workspace key configured; '
        + 'set RELAYCAST_WORKSPACE_KEY or run `agent-relay workspace set_key`',
    );
    return 2;
  }
  const outcome: { observerUrl?: string; warning?: string } = await mint({
    workspaceKey: link.workspaceKey,
    ...(link.baseUrl !== undefined ? { baseUrl: link.baseUrl } : {}),
  }).catch((error): { warning: string } => ({
    warning: error instanceof Error ? error.message : 'unknown mint error',
  }));
  if (outcome.observerUrl === undefined) {
    // Fold the mint's own warning into the refusal so an operator sees the
    // same phrasing they would have gotten under `flows run` -- no extra
    // interpretation, no lossy summary.
    const reason = outcome.warning ?? 'mint returned no URL';
    io.stderr(`REFUSED [observer_link_unavailable] ${reason}`);
    return 2;
  }
  io.stdout(outcome.observerUrl);
  return 0;
}

export async function finalizeObserverLine(
  mint: Promise<{ observerUrl?: string; warning?: string }> | undefined,
  io: CliIo,
  graceMs: number = OBSERVER_FINALIZE_GRACE_MS,
): Promise<void> {
  if (mint === undefined) return;
  // A race between the mint promise and a bounded timer. Using a sentinel
  // symbol (not `undefined`) so we can tell "grace expired" from "mint
  // resolved to no URL and no warning" -- which should never happen, but
  // must not silently claim a timeout if it does.
  const TIMED_OUT: unique symbol = Symbol('observer-finalize-timeout') as never;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), graceMs);
    // Do not let this timer prolong the event loop past a clean exit; if the
    // mint promise resolves first we clear it below, if the process is
    // otherwise idle Node should not wait for us to give up.
    timer.unref?.();
  });
  const outcome = await Promise.race([mint, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome === TIMED_OUT) {
    io.stderr('[observer] mint did not complete in time; continuing without an observer link (the run is unaffected)');
    return;
  }
  if (outcome.warning !== undefined) {
    io.stderr(`[observer] token mint failed: ${outcome.warning}; continuing without an observer link (the run is unaffected)`);
    return;
  }
  if (outcome.observerUrl !== undefined) io.stdout(`Observer: ${outcome.observerUrl}`);
}

function emitWait(
  progress: { runId: string; stepId: string; stepType: string; leaseDeadlineMs: number },
  io: CliIo,
): void {
  io.stderr(
    `WAITING [worker_lease] Run "${progress.runId}" step "${progress.stepId}" (${progress.stepType}) `
      + `is running under a worker lease until ${progress.leaseDeadlineMs}.`,
  );
}

function parseArgs(args: readonly string[]): ParsedArgs | undefined {
  const command = args[0];
  // The verb set lives in exactly one place -- `CLI_VERBS` in cli-commands.ts --
  // which is also what `createRelayCliSurface` projects into `commands`. Gating
  // dispatch on it means a token the surface does not declare can never reach a
  // parser, so the declared tree and the dispatched tree cannot drift apart.
  if (command === undefined || !CLI_VERB_NAMES.has(command)) return undefined;
  if (command === 'add') return args.length === 2 ? { command: 'add', value: args[1]! } : undefined;
  if (command === 'plugin') return parsePluginArgs(args.slice(1));
  if (command === 'replay') return parseReplayArgs(args.slice(1));
  if (command === 'status') return parseStatusArgs(args.slice(1));
  if (command === 'runs') return parseRunsArgs(args.slice(1));
  if (command === 'logs') return parseLogsArgs(args.slice(1));
  if (command === 'build') return parseBuildArgs(args.slice(1));
  if (command === 'deploy') {
    // The positional decides the form: an authored source deploys a hosted
    // listener; a digest reference copies a sealed bundle into a file bucket.
    const source = args.slice(1).find(a => !a.startsWith('-') && isAuthoredFlowPath(a));
    return source !== undefined ? parseCloudDeployArgs(args.slice(1)) : parseDeployArgs(args.slice(1));
  }
  if (command === 'schedule') return parseCloudScheduleArgs(args.slice(1));
  if (command === 'schedules') {
    const rest = args.slice(1);
    if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--json')) return undefined;
    return { command: 'schedules', json: rest.length === 1 };
  }
  if (command === 'unschedule') {
    const rest = args.slice(1).filter(a => a !== '--json');
    const json = args.length - 1 - rest.length;
    if (json > 1 || rest.length !== 1 || rest[0]!.startsWith('-')) return undefined;
    return { command: 'unschedule', scheduleId: rest[0]!, json: json === 1 };
  }
  if (command === 'undeploy') {
    const rest = args.slice(1).filter(a => a !== '--json');
    const json = args.length - 1 - rest.length;
    if (json > 1 || rest.length !== 1 || rest[0]!.startsWith('-')) return undefined;
    return { command: 'undeploy', agentId: rest[0]!, json: json === 1 };
  }
  if (command === 'deployments') {
    const rest = args.slice(1);
    if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--json')) return undefined;
    return { command: 'deployments', json: rest.length === 1 };
  }
  if (command === 'serve-webhook') return parseWebhookArgs(args.slice(1));
  if (command === 'hn-monitor') return parseHnMonitorArgs(args.slice(1));
  if (command === 'tick') return parseTickArgs(args.slice(1));
  if (command === 'observer') return parseObserverArgs(args.slice(1));
  if (command === 'sync') return parseSyncArgs(args.slice(1));
  if (command === 'answer') return parseAnswerArgs(args.slice(1));
  if (command !== 'check' && command !== 'run' && command !== 'resume') return undefined;

  let json = false;
  let watch = false;
  let cloud = false;
  let wait = false;
  let syncCode = false;
  let noConnect = false;
  let localAgent = false;
  let allowHumanInfluenced = false;
  let dataDir = DEFAULT_DATA_DIR;
  let sawDataDir = false;
  let spawn = true;
  let noObserverLink = false;
  let input: string | undefined;
  let sawInput = false;
  let reuseFromRunId: string | undefined;
  let bucket: string | undefined;
  const positionals: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--cloud' || argument === '--wait' || argument === '--sync-code' || argument === '--no-connect') {
      if (command !== 'run') return undefined;
      if (argument === '--cloud' ? cloud : argument === '--wait' ? wait : argument === '--sync-code' ? syncCode : noConnect) return undefined;
      if (argument === '--cloud') cloud = true;
      else if (argument === '--wait') wait = true;
      else if (argument === '--sync-code') syncCode = true;
      else noConnect = true;
      continue;
    }
    if (argument === '--allow-human-influenced') {
      if (command === 'check' || allowHumanInfluenced) return undefined;
      allowHumanInfluenced = true;
      continue;
    }
    if (argument === '--local-agent') {
      if (command === 'check' || localAgent) return undefined;
      localAgent = true;
      continue;
    }
    if (argument === '--watch') {
      if (command !== 'check' || watch) return undefined;
      watch = true;
      continue;
    }
    if (argument === '--json') {
      if (json) return undefined;
      json = true;
      continue;
    }
    if (argument === '--no-spawn') {
      // Refused on `check` for the same reason `--data-dir` is: `check` never
      // opens a socket, so a daemon flag there would describe nothing.
      if (command === 'check' || !spawn) return undefined;
      spawn = false;
      continue;
    }
    if (argument === '--no-observer-link') {
      // Only meaningful on verbs that actually emit the observer line — `run`
      // and `resume`. Refused elsewhere so the flag never silently no-ops.
      if (command === 'check' || noObserverLink) return undefined;
      noObserverLink = true;
      continue;
    }
    if (argument === '--data-dir') {
      const value = args[index + 1];
      if (command === 'check' || sawDataDir || value === undefined || value.startsWith('-')) return undefined;
      dataDir = value;
      sawDataDir = true;
      index += 1;
      continue;
    }
    if (argument === '--reuse-from') {
      const value = args[index + 1];
      if (command !== 'run' || reuseFromRunId !== undefined || !value || value.startsWith('-')) return undefined;
      reuseFromRunId = value;
      index += 1;
      continue;
    }
    if (argument === '--bucket') {
      const value = args[++index];
      if (command !== 'run' || bucket !== undefined || !value || value.startsWith('-')) return undefined;
      bucket = value;
      continue;
    }
    if (argument === '--input') {
      const value = args[index + 1];
      if (command !== 'run' || sawInput || value === undefined || value.startsWith('--')) return undefined;
      input = value;
      sawInput = true;
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) return undefined;
    positionals.push(argument);
  }
  if (positionals.length !== 1) return undefined;

  if (bucket !== undefined && (cloud || !parseDigestReference(positionals[0]!))) return undefined;
  if (cloud) {
    // `--cloud` submits the spec to Cloud, so every flag that only describes a
    // local run -- a data dir, a suppressed daemon, a local agent, a local
    // observer-link opt-out -- describes nothing there and is refused rather
    // than ignored. `--input` is the authored body's argument and travels with
    // the source, so it is accepted exactly where a local run accepts it.
    if (allowHumanInfluenced || sawDataDir || !spawn || localAgent || noObserverLink || reuseFromRunId !== undefined) return undefined;
    if (sawInput && !isAuthoredFlowPath(positionals[0]!)) return undefined;
    return { command: 'cloud-run', value: positionals[0]!, json, wait, input, syncCode, noConnect };
  }
  if (wait || syncCode || noConnect) return undefined;
  if (reuseFromRunId !== undefined && isAuthoredFlowPath(positionals[0]!)) return undefined;

  if (command === 'run' && input !== undefined && !isAuthoredFlowPath(positionals[0]!)) return undefined;
  return command === 'check'
    ? { command, json, watch, value: positionals[0]! }
    : command === 'run'
      ? { command, bucket, reuseFromRunId, localAgent, dataDir, input, json, spawn, noObserverLink, allowHumanInfluenced, value: positionals[0]! }
      : { command, localAgent, dataDir, json, spawn, noObserverLink, allowHumanInfluenced, value: positionals[0]! };
}

/**
 * `flows answer [--json] [--no-spawn] [--data-dir <dir>] [--note <text>] [--by <identity>] <run-id> <wait-id> <yes|no>`.
 * The answer is a literal `yes`/`no` (also `true`/`false`) so a shell cannot
 * hand the kernel an ambiguous word as a decision. `--by` records who answered
 * when the invoker is relaying a person's decision (Cloud's answer route runs
 * this inside the resumed sandbox with the caller's identity); it defaults to
 * the OS user.
 */
function parseAnswerArgs(rest: readonly string[]): ParsedArgs | undefined {
  let json = false;
  let spawn = true;
  let dataDir = DEFAULT_DATA_DIR;
  let sawDataDir = false;
  let note: string | undefined;
  let by: string | undefined;
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === '--json') {
      if (json) return undefined;
      json = true;
      continue;
    }
    if (argument === '--no-spawn') {
      if (!spawn) return undefined;
      spawn = false;
      continue;
    }
    if (argument === '--by') {
      const value = rest[index + 1];
      if (by !== undefined || value === undefined || value.startsWith('-') || value.trim() === '') return undefined;
      by = value;
      index += 1;
      continue;
    }
    if (argument === '--data-dir') {
      const value = rest[index + 1];
      if (sawDataDir || value === undefined || value.startsWith('-')) return undefined;
      dataDir = value;
      sawDataDir = true;
      index += 1;
      continue;
    }
    if (argument === '--note') {
      const value = rest[index + 1];
      if (note !== undefined || value === undefined || value.startsWith('--')) return undefined;
      note = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) return undefined;
    positionals.push(argument);
  }
  if (positionals.length !== 3) return undefined;
  const [runId, waitId, word] = positionals as [string, string, string];
  const answer = word === 'yes' || word === 'true' ? true : word === 'no' || word === 'false' ? false : undefined;
  if (answer === undefined) return undefined;
  return { command: 'answer', dataDir, json, spawn, note, by, runId, waitId, answer };
}

function parseHnMonitorArgs(rest: readonly string[]): ParsedArgs | undefined {
  const sub = rest[0];
  if (sub !== 'start') return undefined;

  let dataDir = DEFAULT_DATA_DIR;
  let sawDataDir = false;
  let pollIntervalMs: number | undefined;
  const positionals: string[] = [];
  for (let index = 1; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === '--data-dir') {
      const value = rest[index + 1];
      if (sawDataDir || value === undefined || value.startsWith('-')) return undefined;
      dataDir = value;
      sawDataDir = true;
      index += 1;
      continue;
    }
    if (argument === '--poll-interval-ms') {
      const value = rest[index + 1];
      if (pollIntervalMs !== undefined || value === undefined || value.startsWith('-')) return undefined;
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
      pollIntervalMs = parsed;
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) return undefined;
    positionals.push(argument);
  }
  if (positionals.length !== 1) return undefined;
  return { command: 'hn-monitor', sub: 'start', dataDir, specPath: positionals[0]!, pollIntervalMs };
}

/**
 * `flows observer`. On-demand mint verb: prints an observer URL without
 * running a flow. Takes an optional `--data-dir` (accepted for parity with
 * other verbs, so operators can share one invocation shape across the
 * surface) but does not open a socket, spawn a daemon, or touch the data
 * directory at all -- the mint is a pure Relaycast API round-trip. No
 * positional argument, no other flags.
 */
/**
 * `flows sync [--json] [--dry-run] [--dir <path>] <run-id>`: apply a hosted
 * run's patch to a local tree, or with `--dry-run` print it and apply nothing.
 */
function parseSyncArgs(args: readonly string[]): ParsedArgs | undefined {
  let json = false;
  let dryRun = false;
  let root: string | undefined;
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--json') {
      if (json) return undefined;
      json = true;
      continue;
    }
    if (argument === '--dry-run') {
      if (dryRun) return undefined;
      dryRun = true;
      continue;
    }
    if (argument === '--dir') {
      const value = args[index + 1];
      if (root !== undefined || value === undefined || value.startsWith('-')) return undefined;
      root = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) return undefined;
    positionals.push(argument);
  }
  if (positionals.length !== 1) return undefined;
  return { command: 'sync', runId: positionals[0]!, json, dryRun, root: root ?? '.' };
}

function parseObserverArgs(rest: readonly string[]): ParsedArgs | undefined {
  let dataDir = DEFAULT_DATA_DIR;
  let sawDataDir = false;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === '--data-dir') {
      const value = rest[index + 1];
      if (sawDataDir || value === undefined || value.startsWith('-')) return undefined;
      dataDir = value;
      sawDataDir = true;
      index += 1;
      continue;
    }
    // Any positional or unknown flag is a shape error: this verb has no
    // spec-path or run-id argument, so silently ignoring extras would be
    // worse than refusing them.
    return undefined;
  }
  return { command: 'observer', dataDir };
}

/**
 * `flows tick start`. Numeric flags are parsed here but their BOUNDS are not
 * re-derived: `runTickRunner` calls `assertTickScheduleValid`, the same
 * function `emitDueTicks` uses, so the CLI's refusal and the emit path's
 * refusal cannot drift. This parser only rejects shapes it cannot turn into a
 * number at all.
 */
function parseTickArgs(rest: readonly string[]): ParsedArgs | undefined {
  const sub = rest[0];
  if (sub !== 'start') return undefined;

  let dataDir = DEFAULT_DATA_DIR;
  let sawDataDir = false;
  let scheduleId: string | undefined;
  let intervalMs: number | undefined;
  let epochMs: number | undefined;
  let maxCatchUp: number | undefined;
  let pollIntervalMs: number | undefined;
  const positionals: string[] = [];

  // Number, not parseInt: parseInt('1.5') is 1, so a fractional --interval-ms
  // would silently become a 1ms schedule instead of being refused. Requiring
  // an exact integer round-trip rejects '1.5', '1e3', '0x10' and ' 1' rather
  // than coercing them into something the operator did not write.
  const takeNumber = (value: string | undefined): number | undefined => {
    if (value === undefined || value.startsWith('-')) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || String(parsed) !== value) return undefined;
    return parsed;
  };

  for (let index = 1; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === '--data-dir') {
      const value = rest[index + 1];
      if (sawDataDir || value === undefined || value.startsWith('-')) return undefined;
      dataDir = value; sawDataDir = true; index += 1; continue;
    }
    if (argument === '--schedule-id') {
      const value = rest[index + 1];
      if (scheduleId !== undefined || value === undefined || value.startsWith('-')) return undefined;
      scheduleId = value; index += 1; continue;
    }
    if (argument === '--interval-ms') {
      if (intervalMs !== undefined) return undefined;
      const value = takeNumber(rest[index + 1]);
      if (value === undefined) return undefined;
      intervalMs = value; index += 1; continue;
    }
    if (argument === '--epoch-ms') {
      if (epochMs !== undefined) return undefined;
      const value = takeNumber(rest[index + 1]);
      if (value === undefined) return undefined;
      epochMs = value; index += 1; continue;
    }
    if (argument === '--max-catch-up') {
      if (maxCatchUp !== undefined) return undefined;
      const value = takeNumber(rest[index + 1]);
      if (value === undefined) return undefined;
      maxCatchUp = value; index += 1; continue;
    }
    if (argument === '--poll-interval-ms') {
      if (pollIntervalMs !== undefined) return undefined;
      const value = takeNumber(rest[index + 1]);
      if (value === undefined) return undefined;
      pollIntervalMs = value; index += 1; continue;
    }
    if (argument.startsWith('-')) return undefined;
    positionals.push(argument);
  }
  if (positionals.length !== 1 || scheduleId === undefined || intervalMs === undefined) return undefined;
  return {
    command: 'tick', sub: 'start', dataDir, specPath: positionals[0]!,
    scheduleId, intervalMs, epochMs, maxCatchUp, pollIntervalMs,
  };
}

function emitCheckReport(report: CheckReport, json: boolean, io: CliIo): void {
  emitDiagnostics(report.diagnostics, io);
  if (json) {
    io.stdout(JSON.stringify(report));
    return;
  }
  for (const gate of report.gates) {
    // A gate that accepts every output is legal, but it must not read like a
    // gate that judges something.
    const vacuous = gate.acceptsAnyOutput === true ? ' [json_schema accepts any output]' : '';
    io.stdout(`GATE step "${gate.stepId}" ${gate.checks.join('+')} from data (kernel, journal-replayable)${vacuous}`);
  }
  for (const schedule of report.schedules ?? []) {
    const declared = schedule.cron !== undefined
      ? `cron "${schedule.cron}"${schedule.tz === undefined ? '' : ` tz ${schedule.tz}`}`
      : `every ${schedule.intervalMs}ms`;
    const local = schedule.localUnsupported !== undefined
      ? `Cloud only: ${schedule.localUnsupported}`
      : `local: flows tick start --schedule-id ${schedule.scheduleId} --interval-ms ${schedule.intervalMs} --epoch-ms ${schedule.epochMs}`;
    io.stdout(`SCHEDULE handler ${schedule.handler} ${declared} -> flows.tick schedule_id ${schedule.scheduleId} [${local}]`);
  }
  for (const extension of report.extensions ?? []) {
    const hookList = (extension.hooks ?? []).length === 0 ? '' : `, hooks: ${extension.hooks!.join(', ')}`;
    io.stdout(`EXTENSION ${extension.name}@${extension.version} ${extension.ref} sha256:${extension.digest} -> ${extension.handlers} handler(s) composed after the base flow${hookList}`);
  }
  if (report.hooks !== undefined) {
    io.stdout(`HOOKS declared: ${report.hooks.declared.join(', ') || '(none)'}`);
    for (const row of report.hooks.implementations) io.stdout(`HOOK ${row.hook} <- ${row.plugin}`);
    for (const name of report.hooks.declared) {
      if (!report.hooks.implementations.some(row => row.hook === name)) io.stdout(`HOOK ${name} <- (none)`);
    }
  }
  for (const resolution of report.resolutions) {
    const config = resolution.source === 'project' && report.projectConfigPath !== undefined
      ? ` (${report.projectConfigPath})`
      : '';
    const model = resolution.model === undefined ? '' : ` model "${resolution.model}"`;
    io.stdout(`RESOLVED step "${resolution.stepId}" cli "${resolution.cli}"${model} from ${resolution.source}${config}`);
  }
  // What the workspace must have connected before this flow can run there;
  // the hosted verbs check the same list against Cloud before submitting.
  const requires = report.requirements === undefined ? '' : describeFlowRequirements(report.requirements);
  if (requires) io.stdout(`REQUIRES ${requires}`);
  if (report.ok) io.stdout(`CHECK PASSED ${report.path ?? ''}`.trimEnd());
}

function emitRunReport(
  execution: RunExecution,
  json: boolean,
  io: CliIo,
  observerUrl?: string,
): void {
  const { report } = execution;
  emitDiagnostics(report.diagnostics, io);
  if (json) {
    // Fold `observerUrl` into the JSON report as a sibling of `runId`, so
    // downstream tooling that consumes `--json` gets the same signal a
    // human reader gets from the plain-text `Observer:` line.
    const payload = observerUrl === undefined ? report : { ...report, observerUrl };
    io.stdout(JSON.stringify(payload));
    return;
  }
  if (report.runId === undefined) return;
  if (report.answer !== undefined) {
    io.stdout(`ANSWERED ${report.runId} ${report.answer.waitId} ${report.answer.answer ? 'yes' : 'no'}`
      + (report.answer.note === undefined ? '' : ` (${report.answer.note})`));
    if (report.next !== undefined) io.stdout(`Continue with: ${report.next}`);
    return;
  }
  // A refused answer changed nothing about the run, so there is no run
  // outcome to summarize; the refusal above is the whole report.
  if (report.command === 'answer') return;
  const completed = report.completedSteps === undefined ? '' : ` (${report.completedSteps} ${report.completedSteps === 1 ? 'step' : 'steps'})`;
  const reason = report.completionReason === undefined
    ? ''
    : ` completionReason: ${report.completionReason}`;
  io.stdout(`RUN ${report.runId} ${report.status ?? 'unknown'}${completed}${reason}`);
  if (report.reuse !== undefined) {
    io.stdout(`REUSE from ${report.reuse.fromRunId}: ${report.reuse.reusedSteps} reused, ${report.reuse.executedSteps} executed`);
  }
  // The observer line no longer rides inline with the RUN summary in
  // plain-text mode: a slow mint used to hold back this whole line and any
  // check diagnostics for up to `MINT_TIMEOUT_MS`. `finalizeObserverLine`
  // now emits `Observer: <url>` as its own follow-up line after this one,
  // matching v1 relayflows' output shape (which also printed the observer
  // URL on its own line). The `observerUrl` parameter is kept for callers
  // that already have a URL ready and want it inline; today only the
  // `--json` path takes that branch (where the URL folds into the JSON
  // payload above), so the plain-text pass through here never uses it.
  if (observerUrl !== undefined) io.stdout(`Observer: ${observerUrl}`);
}

function emitDiagnostics(
  diagnostics: CheckReport['diagnostics'] | RunReport['diagnostics'],
  io: CliIo,
): void {
  for (const diagnostic of diagnostics) {
    io.stderr(`${diagnosticLabel(diagnostic.severity)} [${diagnostic.kind}] ${diagnostic.message}`);
  }
}

function diagnosticLabel(severity: string): string {
  switch (severity) {
    case 'warning': return 'WARNING';
    case 'failure': return 'FAILED';
    case 'parked': return 'PARKED';
    case 'declined': return 'DECLINED';
    default: return 'REFUSED';
  }
}

function isDirectInvocation(entryPath: string | undefined): boolean {
  if (entryPath === undefined) return false;
  try {
    return pathToFileURL(realpathSync(entryPath)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1])) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}

/**
 * The argv parser, exported for the CLI-surface drift test.
 *
 * The drift test must prove that every command `cli-commands.ts` declares
 * actually routes to a `ParsedArgs` variant, and that every variant is
 * reachable from some declared command. Observing that through `runCli` would
 * mean executing the commands. Not part of the package's public API --
 * `@relayflows/sdk/cli` exports `runCli`, and `@relayflows/sdk/relay-cli`
 * exports the surface.
 */
export { parseArgs as parseCliArgs };
