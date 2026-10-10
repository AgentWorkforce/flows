// The local executor for `evaluateFlow`: one fresh `flows run` per case
// against relayflowd, and the case's spend read back from the journals.
// Memoization (`--reuse-from`) is never used: an evaluation must judge the
// candidate's own step results, not a prior version's.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize } from './canonical.js';
import { isAuthoredFlowPath } from './direct-input.js';
import { walkJournal } from './journal-reader.js';
import type { FlowEvalExecutor, FlowEvalRun, FlowEvalStep } from './flow-eval-report.js';
import { runReportOutcome } from './flow-eval-outcome.js';
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
  // The root, not the failing child: a failed authored run reports the child
  // that failed as `runId`, and spend must be read from the whole run.
  const runId = report.rootRunId ?? report.runId;
  return { ...(runId === undefined ? {} : { runId }), ...runReportOutcome(report, execution.exitCode) };
}

/**
 * Spend from the local journals.
 *
 * Summed from each step's own `step.completed` budget, never from a run's
 * `budget_total`: an authored child run starts from the flow's `prior_spend`,
 * so its total already includes every earlier child, and adding totals would
 * count the same dollars repeatedly.
 *
 * An authored root runs each step as a child run with its own journal. The
 * children are found in the root's `authored-steps` stream, which is written
 * as each child opens and so survives a failed body, and in the root step's
 * success output (`journalSteps`).
 */
export async function localRunSpend(runId: string, dataDir: string): Promise<Pick<FlowEvalRun, 'costUsd' | 'tokensIn' | 'tokensOut' | 'steps'>> {
  try {
    const spend: Spend = { dollars: 0, tokensIn: 0, tokensOut: 0 };
    const steps: FlowEvalStep[] = [];
    const visited = new Set<string>();
    const queue: Array<{ runId: string; depth: number }> = [{ runId, depth: 0 }];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (visited.has(next.runId)) continue;
      visited.add(next.runId);
      const read = await readJournal(next.runId, dataDir);
      addSpend(spend, read.spend);
      steps.push(...read.steps);
      // Bounded like `f.dispatch` (depth <= 3).
      if (next.depth < 3) for (const child of read.children) queue.push({ runId: child, depth: next.depth + 1 });
    }
    return { costUsd: spend.dollars === null ? null : roundUsd(spend.dollars), tokensIn: spend.tokensIn, tokensOut: spend.tokensOut, steps };
  } catch {
    // Spend is evidence, not the verdict: an unreadable journal leaves cost unknown.
    return { costUsd: null, tokensIn: null, tokensOut: null };
  }
}

interface Spend { dollars: number | null; tokensIn: number; tokensOut: number }

const AUTHORED_STEP_RECORD = 'relayflows.authored-step.v1';
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

async function readJournal(runId: string, dataDir: string): Promise<{ spend: Spend; steps: FlowEvalStep[]; children: string[] }> {
  const spend: Spend = { dollars: 0, tokensIn: 0, tokensOut: 0 };
  const steps = new Map<string, FlowEvalStep & { startedAt?: number }>();
  const children = new Set<string>();
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
        addSpend(spend, budget);
      }
      steps.set(event.step_id, step);
      for (const child of journalStepRunIds(payload['output'])) children.add(child);
    } else if (event.entry_type === 'stream.appended') {
      for (const child of authoredStepRunIds(payload)) children.add(child);
    }
  }
  children.delete(runId);
  return { spend, steps: [...steps.values()].map(({ startedAt: _startedAt, ...step }) => step), children: [...children] };
}

function journalStepRunIds(output: unknown): string[] {
  if (output === null || typeof output !== 'object') return [];
  const journalSteps = (output as Record<string, unknown>)['journalSteps'];
  if (!Array.isArray(journalSteps)) return [];
  return journalSteps.flatMap(step => {
    const id = step !== null && typeof step === 'object' ? (step as Record<string, unknown>)['runId'] : undefined;
    return typeof id === 'string' && RUN_ID.test(id) ? [id] : [];
  });
}

/** Child run ids from an `authored-steps` index record, wherever the stream envelope nests it. */
function authoredStepRunIds(value: unknown, depth = 0): string[] {
  if (value === null || typeof value !== 'object' || depth > 4) return [];
  const record = value as Record<string, unknown>;
  if (record['index'] === AUTHORED_STEP_RECORD) {
    return typeof record['runId'] === 'string' && RUN_ID.test(record['runId']) ? [record['runId']] : [];
  }
  return Object.values(record).flatMap(nested => authoredStepRunIds(nested, depth + 1));
}

function addSpend(into: Spend, add: Spend): void {
  into.tokensIn += add.tokensIn;
  into.tokensOut += add.tokensOut;
  into.dollars = into.dollars === null || add.dollars === null ? null : into.dollars + add.dollars;
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
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
