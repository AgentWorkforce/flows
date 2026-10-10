// The two built-in executors for `evaluateFlow`: one fresh local run per case
// through relayflowd, or one fresh hosted run per case through Cloud. Neither
// reuses a prior run's outputs — `--reuse-from` memoization would make an eval
// judge the old version's step results, which is exactly what it must not do.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize } from './canonical.js';
import { getCloudRunSteps, type CloudStep } from './cloud-read.js';
import { runInCloud, waitForCloudFlowRun, type RunInCloudOptions } from './cloud-run.js';
import type { CloudConnectionOptions } from './cloud-http.js';
import { isAuthoredFlowPath } from './direct-input.js';
import { walkJournal } from './journal-reader.js';
import type { FlowEvalExecutor, FlowEvalRun, FlowEvalStep } from './flow-eval.js';
import type { RunExecution } from './cli/run.js';

export interface LocalFlowEvalExecutorOptions {
  /** Daemon data directory. Defaults to `.relayflowd`. */
  dataDir?: string;
  /** Attach a local agent/LLM worker, as `flows run --local-agent`. */
  localAgent?: boolean;
  agentCapacity?: number;
  /** `{ spawn: false }` refuses instead of starting a daemon, as `flows run --no-spawn`. */
  daemon?: { spawn?: boolean };
  /** The `flows` CLI entry point. Defaults to this package's own `dist/cli.js`. */
  cliPath?: string;
  /** Working directory for each run. Defaults to this process's. */
  cwd?: string;
}

/**
 * Execute each case as a fresh local run, in its own `flows run` process.
 *
 * A child process per case is deliberate. Authored source is loaded with
 * `import()`, and an ES module is cached by URL for the life of a process: an
 * in-process run would keep executing the FIRST version of a `.flow.ts` it saw,
 * while the report named the edited bytes on disk. A gate must run what it
 * judges, so each case gets a process that has never seen the flow before.
 *
 * Authored `.flow.ts` receives the case input (`{}` when the case has none);
 * declarative YAML/JSON specs take no input, so a case that declares one is
 * refused rather than silently run without it.
 */
export function localFlowEvalExecutor(options: LocalFlowEvalExecutorOptions = {}): FlowEvalExecutor {
  const dataDir = resolve(options.dataDir ?? '.relayflowd');
  return async ({ flow, input, signal }) => {
    if (!('path' in flow) || typeof flow.path !== 'string') {
      throw new Error('The local executor runs flow files; write the spec to a file or use a custom executor.');
    }
    const authored = isAuthoredFlowPath(flow.path);
    if (!authored && input !== undefined) throw new Error('Declarative flows take no input; remove `input` from the case.');
    const scratch = authored ? await mkdtemp(join(tmpdir(), 'flows-eval-')) : undefined;
    try {
      const args = [options.cliPath ?? defaultCliPath(), 'run', '--json', '--no-observer-link', '--data-dir', dataDir];
      if (options.daemon?.spawn === false) args.push('--no-spawn');
      if (options.localAgent) args.push('--local-agent');
      if (options.agentCapacity !== undefined) args.push('--agent-capacity', String(options.agentCapacity));
      args.push(resolve(flow.path));
      if (scratch !== undefined) {
        // A file, never inline: an inline argument that happens to name a file
        // in the working directory would be read as that file.
        const inputPath = join(scratch, 'input.json');
        await writeFile(inputPath, canonicalize(input ?? {}));
        args.push('--input', inputPath);
      }
      const execution = await runCliProcess(args, options.cwd, signal);
      const run = localRunOutcome(execution);
      if (run.runId !== undefined && run.completionReason !== 'refused') {
        Object.assign(run, await localRunSpend(run.runId, dataDir));
      }
      return run;
    } finally {
      if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
    }
  };
}

function defaultCliPath(): string {
  // Built: this file sits beside cli.js in dist/. From source (tests), use the build.
  const sibling = fileURLToPath(new URL('./cli.js', import.meta.url));
  return existsSync(sibling) ? sibling : fileURLToPath(new URL('../dist/cli.js', import.meta.url));
}

function runCliProcess(args: string[], cwd: string | undefined, signal: AbortSignal | undefined): Promise<RunExecution> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      ...(cwd === undefined ? {} : { cwd }), stdio: ['ignore', 'pipe', 'pipe'],
      ...(signal === undefined ? {} : { signal }),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4_000); });
    child.once('error', reject);
    child.once('close', (code) => {
      const line = stdout.trim().split('\n').reverse().find(candidate => candidate.startsWith('{'));
      let report: RunExecution['report'] | undefined;
      try {
        report = line === undefined ? undefined : JSON.parse(line) as RunExecution['report'];
      } catch { /* reported below */ }
      if (report === undefined || typeof report.ok !== 'boolean' || !Array.isArray(report.diagnostics)) {
        reject(new Error(`flows run exited ${code} without a JSON report: ${stderr.trim() || stdout.trim() || '(no output)'}`));
        return;
      }
      resolvePromise({ exitCode: (code ?? 1) as RunExecution['exitCode'], report });
    });
  });
}

/** Map a local `RunExecution` onto the eval vocabulary. Exported for tests. */
export function localRunOutcome(execution: RunExecution): FlowEvalRun {
  const { report } = execution;
  const runId = report.runId ?? report.rootRunId;
  const detail = report.completionDetail
    ?? report.diagnostics.find(d => d.severity === 'failure' || d.severity === 'refusal' || d.severity === 'parked')?.message;
  let completionReason: string;
  if (execution.exitCode === 2) completionReason = 'refused';
  else if (report.status === 'parked' || execution.exitCode === 3) completionReason = 'needs_human';
  else if (report.ok && report.diagnostics.some(d => d.kind === 'run_declined')) completionReason = 'declined';
  else if (report.ok) completionReason = 'success';
  else completionReason = report.completionReason ?? (report.status === 'suspended' ? 'suspended' : 'failed');
  return {
    ...(runId === undefined ? {} : { runId }),
    completionReason,
    ...(detail === undefined ? {} : { completionDetail: detail }),
  };
}

/**
 * Spend from the local journals: `run.completed.budget_total` when the run
 * terminated, else the sum of its steps' completions. An authored root runs
 * each step as a child run with its own journal; those children are named in
 * the root step's output (`journalSteps`) and their spend is added here, so an
 * authored flow's cost is not reported as the root's near-zero bookkeeping.
 */
export async function localRunSpend(runId: string, dataDir: string): Promise<Pick<FlowEvalRun, 'costUsd' | 'tokensIn' | 'tokensOut' | 'steps'>> {
  try {
    const visited = new Set<string>();
    const spend = await journalSpend(runId, dataDir, visited, 0);
    return { costUsd: spend.dollars, tokensIn: spend.tokensIn, tokensOut: spend.tokensOut, steps: spend.steps };
  } catch {
    // Spend is evidence, not the verdict: an unreadable journal leaves cost unknown.
    return { costUsd: null, tokensIn: null, tokensOut: null };
  }
}

interface Spend { dollars: number | null; tokensIn: number; tokensOut: number }

async function journalSpend(
  runId: string, dataDir: string, visited: Set<string>, depth: number,
): Promise<Spend & { steps: FlowEvalStep[] }> {
  visited.add(runId);
  let total: Spend | undefined;
  const summed: Spend = { dollars: 0, tokensIn: 0, tokensOut: 0 };
  const steps = new Map<string, FlowEvalStep & { startedAt?: number }>();
  const children: string[] = [];
  for await (const event of walkJournal(runId, dataDir)) {
    const payload = (event.payload !== null && typeof event.payload === 'object' ? event.payload : {}) as Record<string, unknown>;
    if (event.entry_type === 'step.attempt.started' && event.step_id !== null) {
      const step = steps.get(event.step_id) ?? { id: event.step_id, status: 'running' };
      step.startedAt ??= event.at_ms;
      steps.set(event.step_id, step);
    } else if (event.entry_type === 'step.completed' && event.step_id !== null) {
      const budget = readBudget(payload['budget']);
      const step = steps.get(event.step_id) ?? { id: event.step_id, status: 'done' };
      step.status = typeof payload['completionReason'] === 'string' ? payload['completionReason'] : 'done';
      if (step.startedAt !== undefined) step.durationMs = event.at_ms - step.startedAt;
      if (budget !== undefined) {
        step.costUsd = budget.dollars;
        addSpend(summed, budget);
      }
      steps.set(event.step_id, step);
      children.push(...childRunIds(payload['output']));
    } else if (event.entry_type === 'run.completed') {
      total = readBudget(payload['budget_total']);
    }
  }
  const spend: Spend = { ...(total ?? summed) };
  const all: FlowEvalStep[] = [...steps.values()].map(({ startedAt: _startedAt, ...step }) => step);
  // Bounded like `f.dispatch` (depth <= 3), and cycle-safe.
  if (depth < 3) {
    for (const child of children) {
      if (visited.has(child)) continue;
      const nested = await journalSpend(child, dataDir, visited, depth + 1);
      addSpend(spend, nested);
      all.push(...nested.steps);
    }
  }
  return { ...spend, steps: all };
}

function childRunIds(output: unknown): string[] {
  if (output === null || typeof output !== 'object') return [];
  const journalSteps = (output as Record<string, unknown>)['journalSteps'];
  if (!Array.isArray(journalSteps)) return [];
  return journalSteps.flatMap(step => step !== null && typeof step === 'object'
    && typeof (step as Record<string, unknown>)['runId'] === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test((step as Record<string, unknown>)['runId'] as string)
    ? [(step as Record<string, unknown>)['runId'] as string] : []);
}

function addSpend(into: Spend, add: Spend): void {
  into.tokensIn += add.tokensIn;
  into.tokensOut += add.tokensOut;
  into.dollars = into.dollars === null || add.dollars === null ? null : into.dollars + add.dollars;
}

export interface CloudFlowEvalExecutorOptions extends CloudConnectionOptions {
  workspaceId?: string;
  syncCode?: RunInCloudOptions['syncCode'];
  pollIntervalMs?: number;
}

/**
 * Execute each case as a fresh hosted run and wait for it. Needs a token with
 * `workflow:invoke:write` and `runs:read`; inside a Cloud step that means an
 * injected workspace token, since a run-scoped sandbox token reads only its own run.
 */
export function cloudFlowEvalExecutor(options: CloudFlowEvalExecutorOptions = {}): FlowEvalExecutor {
  return async ({ flow, input, signal }) => {
    const connection: CloudConnectionOptions = {
      ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
      ...(options.token === undefined ? {} : { token: options.token }),
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(signal === undefined ? {} : { signal }),
    };
    const receipt = await runInCloud(flow, {
      ...connection,
      ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
      ...(options.syncCode === undefined ? {} : { syncCode: options.syncCode }),
      // Cloud requires an explicit input for authored source; `{}` is the
      // documented "no fields", matching the local executor's default.
      ...(input !== undefined ? { input } : 'path' in flow && isAuthoredFlowPath(flow.path) ? { input: {} } : {}),
    });
    const state = await waitForCloudFlowRun(receipt.runId, {
      ...connection, ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    });
    const completionReason = 'completionReason' in state ? state.completionReason : state.status;
    let steps: CloudStep[] | undefined;
    try {
      steps = await getCloudRunSteps(receipt.runId, connection);
    } catch {
      // As locally: spend is evidence, not the verdict.
    }
    return { runId: receipt.runId, completionReason, ...cloudSpend(steps) };
  };
}

/** Sum hosted step spend; any step with unknown cost makes the total unknown. Exported for tests. */
export function cloudSpend(steps: readonly CloudStep[] | undefined): Pick<FlowEvalRun, 'costUsd' | 'tokensIn' | 'tokensOut' | 'steps'> {
  if (steps === undefined) return { costUsd: null, tokensIn: null, tokensOut: null };
  const known = (values: Array<number | null>): number | null =>
    values.some(v => v === null) ? null : values.reduce<number>((sum, v) => sum + v!, 0);
  const costed = steps.filter(step => step.step_type === 'agent' || step.step_type === 'llm' || step.cost_usd !== null);
  return {
    costUsd: known(costed.map(step => step.cost_usd)),
    tokensIn: known(costed.map(step => step.tokens_in)),
    tokensOut: known(costed.map(step => step.tokens_out)),
    steps: steps.map(step => ({ id: step.step_name, status: step.status, durationMs: step.duration_ms, costUsd: step.cost_usd })),
  };
}

function readBudget(value: unknown): { dollars: number | null; tokensIn: number; tokensOut: number } | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const budget = value as Record<string, unknown>;
  const dollars = typeof budget['dollars'] === 'string' ? Number(budget['dollars']) : NaN;
  return {
    dollars: budget['dollars_unmetered'] === true || !Number.isFinite(dollars) ? null : dollars,
    tokensIn: typeof budget['tokens_in'] === 'number' ? budget['tokens_in'] : 0,
    tokensOut: typeof budget['tokens_out'] === 'number' ? budget['tokens_out'] : 0,
  };
}
