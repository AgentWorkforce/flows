#!/usr/bin/env node
import { addPlugin } from './cli/add.js';
import { watchCheck } from './cli-watch.js';
import { checkHelperBody } from './cli/check-helper-body.js';

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
import { checkAuthoredTriggers } from './cli/check-triggers.js';
import { parseWebhookArgs, runServeWebhook } from './cli/serve-webhook.js';
import { runDirectFlow } from './cli/direct-run.js';
import { parseReplayArgs, replayJournal, type ReplayArgs } from './cli/replay.js';
import { checkTypeScriptFlow } from './cli/check-typescript.js';
import { runCloudCli } from './cli/cloud-run.js';
import { isAuthoredFlowPath } from './direct-input.js';
import { parseDeployArgs, runDeploy, type DeployArgs } from './cli/deploy.js';
import { parseDigestReference } from './bundle-transport.js';
import { parseBuildArgs, runBuild, type BuildArgs } from './cli/build.js';
import { runHnMonitor } from './cli/hn-monitor.js';
import { runTickRunner } from './cli/tick-runner.js';
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
type ParsedArgs =
  | { command: 'add'; value: string }
  | ReplayArgs
  | BuildArgs
  | DeployArgs
  | { command: 'serve-webhook'; dataDir: string; port: number; admitted?: readonly string[] }
  | { command: 'cloud-run'; value: string; json: boolean; wait: boolean }
  | { command: 'check'; json: boolean; watch: boolean; value: string }
  | { command: 'run'; bucket: string | undefined; reuseFromRunId: string | undefined; localAgent: boolean; dataDir: string; input: string | undefined; json: boolean; spawn: boolean; noObserverLink: boolean; allowHumanInfluenced: boolean; value: string }
  | { command: 'resume'; dataDir: string; json: boolean; spawn: boolean; noObserverLink: boolean; allowHumanInfluenced: boolean; value: string }
  | { command: 'observer'; dataDir: string }
  | { command: 'hn-monitor'; sub: 'start'; dataDir: string; specPath: string; pollIntervalMs: number | undefined }
  | { command: 'tick'; sub: 'start'; dataDir: string; specPath: string; scheduleId: string;
      intervalMs: number; epochMs: number | undefined; maxCatchUp: number | undefined;
      pollIntervalMs: number | undefined };

const DEFAULT_DATA_DIR = '.relayflowd';
const USAGE = [
  'Usage:',
  'flows add <helper-name|@flows/helper-name>',
  'flows build [--out <dir>] <flow.yaml|flow.ts>',
  'flows build --verify <bundle-dir>',
  'flows deploy <flow>@sha256:<digest> --to <file-bucket-uri>',
  'flows run <flow>@sha256:<digest> [--bucket <file-bucket-uri>] [--data-dir <dir>] [--json]',
  'flows check [--watch] [--json] <flow.ts|flow.yaml|spec.json>',
  'flows serve-webhook --data-dir <dir> --port <p> [--allow <name>[,<name>]]',
  'flows run [--json] [--no-spawn] [--no-observer-link] [--data-dir <dir>] [--local-agent] [--reuse-from <run-id>] <flow.yaml|spec.json>',
  'flows run --cloud [--json] [--wait] <flow.yaml|spec.json>',
  'flows run [--json] [--no-spawn] [--no-observer-link] [--data-dir <dir>] [--local-agent] <flow.ts> --input <inline-json-or-file>',
  'flows tick start --schedule-id <id> --interval-ms <ms> [--epoch-ms <ms>] [--max-catch-up <n>] [--poll-interval-ms <ms>] [--data-dir <dir>] <spec.json>',
  'flows resume [--allow-human-influenced] [--json] [--no-spawn] [--no-observer-link] [--data-dir <dir>] <run-id>',
  'flows replay [--allow-human-influenced] [--json] [--data-dir <dir>] <run-id> [--at <step-id>]',
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

export async function runCli(
  args: readonly string[],
  io: CliIo = PROCESS_IO,
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

  if (parsed.command === 'serve-webhook') return runServeWebhook(parsed, io);

  if (parsed.command === 'cloud-run') return runCloudCli(parsed, io);
  if (parsed.command === 'replay') return replayJournal(parsed, io);
  if (parsed.command === 'build') return runBuild(parsed, io);
  if (parsed.command === 'deploy') return runDeploy(parsed, io);

  if (parsed.command === 'check') {
    if (parsed.watch) return watchCheck(parsed.value, parsed.json, io);
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
    const controller = new AbortController();
    const onSignal = (): void => controller.abort();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      return await runHnMonitor({
        dataDir: parsed.dataDir,
        specPath: parsed.specPath,
        pollIntervalMs: parsed.pollIntervalMs,
        signal: controller.signal,
      }, io);
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
  }

  if (parsed.command === 'tick') {
    const controller = new AbortController();
    const onSignal = (): void => controller.abort();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      return await runTickRunner({
        dataDir: parsed.dataDir,
        specPath: parsed.specPath,
        schedule: {
          scheduleId: parsed.scheduleId,
          intervalMs: parsed.intervalMs,
          ...(parsed.epochMs === undefined ? {} : { epochMs: parsed.epochMs }),
          ...(parsed.maxCatchUp === undefined ? {} : { maxCatchUp: parsed.maxCatchUp }),
        },
        pollIntervalMs: parsed.pollIntervalMs,
        signal: controller.signal,
      }, io) as CliExitCode;
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
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
    localAgent: parsed.command === 'run' && parsed.localAgent,
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
    io.stderr(`[observer] token mint failed: ${outcome.warning}; skipping observer link`);
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
    io.stderr('[observer] mint did not complete in time; skipping observer link');
    return;
  }
  if (outcome.warning !== undefined) {
    io.stderr(`[observer] token mint failed: ${outcome.warning}; skipping observer link`);
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
  if (command === 'add') return args.length === 2 ? { command: 'add', value: args[1]! } : undefined;
  if (command === 'replay') return parseReplayArgs(args.slice(1));
  if (command === 'build') return parseBuildArgs(args.slice(1));
  if (command === 'deploy') return parseDeployArgs(args.slice(1));
  if (command === 'serve-webhook') return parseWebhookArgs(args.slice(1));
  if (command === 'hn-monitor') return parseHnMonitorArgs(args.slice(1));
  if (command === 'tick') return parseTickArgs(args.slice(1));
  if (command === 'observer') return parseObserverArgs(args.slice(1));
  if (command !== 'check' && command !== 'run' && command !== 'resume') return undefined;

  let json = false;
  let watch = false;
  let cloud = false;
  let wait = false;
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
    if (argument === '--cloud' || argument === '--wait') {
      if (command !== 'run' || (argument === '--cloud' ? cloud : wait)) return undefined;
      if (argument === '--cloud') cloud = true;
      else wait = true;
      continue;
    }
    if (argument === '--allow-human-influenced') {
      if (command === 'check' || allowHumanInfluenced) return undefined;
      allowHumanInfluenced = true;
      continue;
    }
    if (argument === '--local-agent') {
      if (command !== 'run' || localAgent) return undefined;
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
    // local run -- an inline input, a data dir, a suppressed daemon, a local
    // agent, a local observer-link opt-out -- describes nothing there and is
    // refused rather than ignored.
    if (allowHumanInfluenced || sawInput || sawDataDir || !spawn || localAgent || noObserverLink || reuseFromRunId !== undefined) return undefined;
    return { command: 'cloud-run', value: positionals[0]!, json, wait };
  }
  if (wait) return undefined;
  if (reuseFromRunId !== undefined && isAuthoredFlowPath(positionals[0]!)) return undefined;

  if (command === 'run' && input !== undefined && !isAuthoredFlowPath(positionals[0]!)) return undefined;
  return command === 'check'
    ? { command, json, watch, value: positionals[0]! }
    : command === 'run'
      ? { command, bucket, reuseFromRunId, localAgent, dataDir, input, json, spawn, noObserverLink, allowHumanInfluenced, value: positionals[0]! }
      : { command, dataDir, json, spawn, noObserverLink, allowHumanInfluenced, value: positionals[0]! };
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
  for (const resolution of report.resolutions) {
    const config = resolution.source === 'project' && report.projectConfigPath !== undefined
      ? ` (${report.projectConfigPath})`
      : '';
    const model = resolution.model === undefined ? '' : ` model "${resolution.model}"`;
    io.stdout(`RESOLVED step "${resolution.stepId}" cli "${resolution.cli}"${model} from ${resolution.source}${config}`);
  }
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
