// `flows runs`, `flows logs` and `flows status --cloud`: reading a hosted run.
//
// The local `flows status` (cli/status.ts) answers "what is this run doing"
// from a journal on the same disk. These three answer the same question about
// a run that executed in Cloud, for an agent holding its own user's Cloud
// credential -- so it does not have to hand-roll HTTP, learn four route
// shapes, or decide for itself what a 404 means.
//
// Presentation only. `cloud-read.ts` owns the requests and the field names;
// `cloud-transcript.ts` owns the JSONL vocabulary; this module owns the page
// and the refusals, and deliberately renders in the grammar cli/status.ts
// already uses (`RUN` / `steps N` / one glyph-led line per step, indented
// facts beneath it) so a reader who knows one knows the other.

import { canonicalize } from '../canonical.js';
import {
  getCloudRunDetail, getCloudRunLog, getCloudRunSteps, listCloudRuns,
  type CloudRunDetail, type CloudStep,
} from '../cloud-read.js';
import { parseAgentTranscript, renderAgentTranscript } from '../cloud-transcript.js';
import { redact } from '../redact.js';
import { errorLines, instant, safe, thousands } from './cloud-format.js';
import { fail, refusalFor, RUN_ID_REQUIRED, type CloudReadOptions } from './cloud-refusal.js';
import { renderCloudStatus, scrubRun, scrubSteps } from './cloud-status-view.js';
import type { CliIo } from '../cli.js';

export interface RunsArgs {
  command: 'runs';
  limit: number;
  json: boolean;
}

export interface LogsArgs {
  command: 'logs';
  runId: string;
  step: string | undefined;
  raw: boolean;
  json: boolean;
  /** `--follow`: append new runner output until the run is terminal (cli/cloud-live.ts). */
  follow: boolean;
}

/** Enough runs to recognise the one you mean; `--limit` raises it. */
export const DEFAULT_RUN_LIMIT = 20;

export function parseRunsArgs(args: readonly string[]): RunsArgs | undefined {
  let limit: number | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--json') {
      if (json) return undefined;
      json = true;
    } else if (argument === '--limit') {
      const value = args[++index];
      if (limit !== undefined || value === undefined || !/^\d{1,4}$/u.test(value) || Number(value) < 1) return undefined;
      limit = Number(value);
    } else {
      return undefined;
    }
  }
  return { command: 'runs', limit: limit ?? DEFAULT_RUN_LIMIT, json };
}

export function parseLogsArgs(args: readonly string[]): LogsArgs | undefined {
  let step: string | undefined;
  let raw = false;
  let json = false;
  let follow = false;
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--json') {
      if (json) return undefined;
      json = true;
    } else if (argument === '--raw') {
      if (raw) return undefined;
      raw = true;
    } else if (argument === '--follow') {
      if (follow) return undefined;
      follow = true;
    } else if (argument === '--step') {
      const value = args[++index];
      if (step !== undefined || value === undefined || value.length === 0 || value.startsWith('-')) return undefined;
      step = value;
    } else if (argument.startsWith('-')) {
      return undefined;
    } else {
      positionals.push(argument);
    }
  }
  if (positionals.length !== 1) return undefined;
  return { command: 'logs', runId: positionals[0]!, step, raw, json, follow };
}

// ---------------------------------------------------------------- flows runs

export async function runCloudRunsCli(
  args: RunsArgs,
  io: CliIo,
  options: CloudReadOptions = {},
): Promise<0 | 1 | 2> {
  const env = options.env ?? process.env;
  let page;
  try {
    page = await listCloudRuns(args.limit, options);
  } catch (error) {
    return fail(refusalFor(error, 'the run list', env), args.json, io);
  }
  const runs = page.runs.map((run) => ({
    ...run,
    name: redact(run.name, env),
    error: run.error === null ? null : redact(run.error, env),
  }));
  if (args.json) {
    io.stdout(canonicalize({ v: 1, ok: true, runs, more: page.more }));
    return 0;
  }
  io.stdout(`runs ${runs.length}${page.more ? ` (more available; pass --limit)` : ''}`);
  if (runs.length === 0) {
    io.stdout('  no runs visible to this credential');
    return 0;
  }
  const nameWidth = Math.max(4, ...runs.map((run) => Math.min(32, run.name.length)));
  const statusWidth = Math.max(6, ...runs.map((run) => run.status.length));
  for (const run of runs) {
    const cells = [
      run.run_id,
      safe(run.name).slice(0, 32).padEnd(nameWidth),
      run.status.padEnd(statusWidth),
      run.completion_reason === null ? null : safe(run.completion_reason),
      `started ${instant(run.created_at)}`,
      `updated ${instant(run.updated_at)}`,
    ].filter((cell): cell is string => cell !== null);
    io.stdout(`RUN ${cells.join('  ')}`);
    if (run.pull_request_url !== null) io.stdout(`      pr ${run.pull_request_url}`);
    if (run.error !== null) {
      io.stdout('      error');
      for (const line of errorLines(run.error, '        ')) io.stdout(line);
    }
  }
  return 0;
}

// ---------------------------------------------------------------- flows logs

export async function runCloudLogsCli(
  args: LogsArgs,
  io: CliIo,
  options: CloudReadOptions = {},
): Promise<0 | 1 | 2> {
  const env = options.env ?? process.env;
  const subject = args.step === undefined ? `run ${args.runId}` : `step "${args.step}" of run ${args.runId}`;
  let log;
  try {
    log = await getCloudRunLog(args.runId, args.step, options);
  } catch (error) {
    return fail(refusalFor(error, subject, env), args.json, io);
  }

  // The logs route answers 200 with an empty body for a sandbox id it does not
  // know, so an unknown `--step` is indistinguishable from a step that has
  // written nothing -- from this response alone. The step list distinguishes
  // them, and is only fetched on this path, so the happy path stays one request.
  if (args.step !== undefined && log.content.length === 0) {
    let steps: CloudStep[];
    try {
      steps = await getCloudRunSteps(args.runId, options);
    } catch (error) {
      // The step list is the only evidence for either message, so without it
      // there is no finding to report. A 403 or a timed-out read must reach
      // the caller as what it is — retryable, or a scope to fix — and never
      // as `cloud_step_no_transcript`, which says the invocation was wrong.
      return fail(refusalFor(error, `the steps of run ${args.runId}`, env), args.json, io);
    }
    const named = steps.some((step) => step.sandbox_id === args.step || step.step_name === args.step);
    const withLogs = steps.filter((step) => step.sandbox_id.length > 0).map((step) => step.sandbox_id);
    const available = withLogs.length === 0
      ? 'this run has no step with its own transcript'
      : `steps with a transcript: ${withLogs.map(safe).join(', ')}`;
    return fail({
      code: 'cloud_step_no_transcript', exit: 2,
      message: named
        ? `Step "${safe(args.step)}" of run ${args.runId} has no transcript${log.done ? '' : ' yet'}. `
          + 'Only an agent step writes one; a deterministic step has none.'
        : `Run ${args.runId} has no step "${safe(args.step)}" — ${available}.`,
    }, args.json, io);
  }

  const content = redact(log.content, env);
  if (args.json) {
    const parsed = args.step === undefined || args.raw ? undefined : parseAgentTranscript(log.content, env);
    io.stdout(canonicalize({
      v: 1, ok: true, run_id: args.runId, step: args.step ?? null,
      bytes: log.offset, total_bytes: log.total_size, done: log.done,
      ...(parsed === undefined ? { content } : { entries: parsed.entries as unknown }),
    }));
    return 0;
  }

  const where = args.step === undefined ? 'runner' : `step ${safe(args.step)}`;
  io.stdout(`LOG ${args.runId}  ${where}  ${thousands(log.total_size)} bytes  ${log.done ? 'complete' : 'still running'}`);
  if (content.length === 0) {
    io.stdout('  (empty)');
    return 0;
  }
  // `--raw` means unrendered, not unredacted: a credential an agent echoed
  // into its transcript must not reach a terminal because a flag was passed.
  if (args.raw || args.step === undefined) {
    for (const line of content.split('\n')) io.stdout(line);
    return 0;
  }
  const parsed = parseAgentTranscript(log.content, env);
  if (!parsed.stream_json) {
    io.stdout('  not a stream-json transcript; printed as written');
    for (const line of content.split('\n')) io.stdout(line);
    return 0;
  }
  for (const line of renderAgentTranscript(parsed)) io.stdout(line);
  return 0;
}

// -------------------------------------------------------- flows status --cloud

export async function runCloudStatusCli(
  args: { runId?: string; json: boolean },
  io: CliIo,
  options: CloudReadOptions = {},
): Promise<0 | 1 | 2> {
  const env = options.env ?? process.env;
  const now = (options.now ?? Date.now)();
  if (args.runId === undefined || args.runId.length === 0) return fail(RUN_ID_REQUIRED, args.json, io);
  let run: CloudRunDetail;
  let steps: CloudStep[];
  try {
    run = await getCloudRunDetail(args.runId, options);
    steps = await getCloudRunSteps(args.runId, options);
  } catch (error) {
    return fail(refusalFor(error, `run ${args.runId}`, env), args.json, io);
  }
  const scrubbed = scrubRun(run, env);
  const scrubbedSteps = scrubSteps(steps, env);
  if (args.json) {
    io.stdout(canonicalize({ v: 1, ok: true, run: scrubbed, steps: scrubbedSteps, now_ms: now }));
    return 0;
  }
  for (const line of renderCloudStatus(scrubbed, scrubbedSteps, now)) io.stdout(line);
  return 0;
}
