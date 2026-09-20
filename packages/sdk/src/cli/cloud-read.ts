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
import { CloudFlowError, type CloudConnectionOptions } from '../cloud-http.js';
import {
  getCloudRunDetail, getCloudRunLog, getCloudRunSteps, listCloudRuns,
  type CloudRunDetail, type CloudStep,
} from '../cloud-read.js';
import { parseAgentTranscript, renderAgentTranscript } from '../cloud-transcript.js';
import { redact } from '../redact.js';
import { formatDuration } from './status.js';
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
}

/** Enough runs to recognise the one you mean; `--limit` raises it. */
export const DEFAULT_RUN_LIMIT = 20;

/** Injected by tests; production takes the ambient clock and environment. */
export interface CloudReadOptions extends CloudConnectionOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

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
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--json') {
      if (json) return undefined;
      json = true;
    } else if (argument === '--raw') {
      if (raw) return undefined;
      raw = true;
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
  return { command: 'logs', runId: positionals[0]!, step, raw, json };
}

/**
 * Every way these verbs can refuse, as a code and a sentence.
 *
 * Each one names the thing to do next. A missing credential names
 * `agent-relay cloud login` because that is the command that fixes it; a 404
 * names `flows runs` because the usual cause is a run id from another
 * workspace, and the list is how you find yours.
 */
interface Refusal { code: string; message: string; exit: 1 | 2 }

function refusalFor(error: unknown, subject: string, env: NodeJS.ProcessEnv): Refusal {
  const clean = (message: string): string => redact(message, env);
  if (error instanceof CloudFlowError) {
    if (error.code === 'configuration') {
      switch (error.reason) {
        case 'auth_missing':
          return {
            code: 'cloud_auth_missing', exit: 2,
            message: 'No Cloud credential. Sign in with `agent-relay cloud login`, or set FLOWS_CLOUD_TOKEN to a '
              + 'Cloud API token with workflow:runs:read (and workflow:logs:read for `flows logs`).',
          };
        case 'auth_expired':
          return { code: 'cloud_auth_expired', exit: 2, message: clean(error.message) };
        case 'url_mismatch':
          return { code: 'cloud_url_mismatch', exit: 2, message: clean(error.message) };
        default:
          return { code: 'cloud_configuration', exit: 2, message: clean(error.message) };
      }
    }
    if (error.code === 'http_error') {
      if (error.status === 401) {
        return {
          code: 'cloud_auth_rejected', exit: 2,
          message: 'Cloud rejected the credential (HTTP 401). The token is unknown or revoked; '
            + 'sign in again with `agent-relay cloud login`.',
        };
      }
      if (error.status === 403) {
        return {
          code: 'cloud_forbidden', exit: 2,
          message: `The credential is valid but not allowed to read ${subject} (HTTP 403). `
            + 'A run-scoped sandbox token may only read its own run; a workspace token needs '
            + 'workflow:runs:read, and workflow:logs:read or workflow:invoke:read for logs.',
        };
      }
      if (error.status === 404) {
        return {
          code: 'cloud_run_not_found', exit: 2,
          message: `Cloud has no ${subject} visible to this credential (HTTP 404). `
            + 'It may belong to another workspace; `flows runs` lists the ones this credential can read.',
        };
      }
      return { code: 'cloud_http_error', exit: 1, message: clean(error.message) };
    }
    if (error.code === 'invalid_input') return { code: 'invalid_invocation', exit: 2, message: clean(error.message) };
    if (error.code === 'transient_error' || error.code === 'transport_error') {
      return { code: error.code === 'transient_error' ? 'cloud_unreachable' : 'cloud_transport_failed', exit: 1, message: clean(error.message) };
    }
    return { code: 'cloud_invalid_response', exit: 1, message: clean(error.message) };
  }
  return { code: 'cloud_read_failed', exit: 1, message: clean(error instanceof Error ? error.message : String(error)) };
}

function fail(refusal: Refusal, json: boolean, io: CliIo): 1 | 2 {
  if (json) io.stdout(canonicalize({ v: 1, ok: false, code: refusal.code, message: refusal.message }));
  else io.stderr(`REFUSED [${refusal.code}] ${refusal.message}`);
  return refusal.exit;
}

function thousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

function dollars(value: number): string {
  return `$${value.toFixed(6).replace(/0+$/u, '').replace(/\.$/u, '')}`;
}

/** Agent- and flow-authored names cannot inject terminal control sequences. */
function safe(text: string): string {
  return text.replace(/[\u0000-\u001F\u007F-\u009F]/gu, '?');
}

/** ISO-8601 to the second: a list column, not a timestamp to do arithmetic on. */
function instant(value: string | null): string {
  if (value === null) return 'unknown';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().replace(/\.\d{3}Z$/u, 'Z') : 'unknown';
}

function ago(value: string | null, now: number): string {
  if (value === null) return 'unknown';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? `${formatDuration(now - parsed)} ago` : 'unknown';
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
    if (run.error !== null) io.stdout(`      error ${safe(run.error)}`);
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

const GLYPH: Record<string, string> = {
  completed: '✓', succeeded: '✓', failed: '✗', cancelled: '✗', running: '↻', pending: '○', queued: '○',
};

function glyph(step: CloudStep): string {
  if (step.status === 'completed' && step.completion_reason !== null && step.completion_reason !== 'success') return '✗';
  return GLYPH[step.status] ?? '○';
}

/** The `steps N: 3 done · 1 running` line, counted off whatever Cloud called each status. */
function stepCounts(steps: readonly CloudStep[]): string {
  const counts = new Map<string, number>();
  for (const step of steps) counts.set(step.status, (counts.get(step.status) ?? 0) + 1);
  const parts = [...counts].map(([status, count]) => `${count} ${status}`);
  return `steps ${steps.length}${parts.length === 0 ? '' : `: ${parts.join(' · ')}`}`;
}

function renderStep(step: CloudStep, runId: string, idWidth: number): string[] {
  const cells = [
    safe(step.step_name).slice(0, 24).padEnd(idWidth),
    step.step_type.padEnd(13),
    step.status.padEnd(11),
  ];
  const attempts = step.attempts.length;
  if (attempts > 0) cells.push(`${attempts} attempt${attempts === 1 ? '' : 's'}`);
  if (step.duration_ms !== null) cells.push(formatDuration(step.duration_ms));
  if (step.completion_reason !== null) cells.push(safe(step.completion_reason));
  if (step.gate !== null) cells.push(`gate: ${safe(step.gate.gate)} ${safe(step.gate.verdict)}`);
  const lines = [`  ${glyph(step)} ${cells.join('  ')}`.trimEnd()];

  if (step.gate !== null && step.gate.verdict !== 'pass' && step.gate.detail.length > 0) {
    lines.push(`        gate: ${safe(step.gate.gate)} ${step.gate.verdict.toUpperCase()} — ${JSON.stringify(safe(step.gate.detail))}`);
  }
  const transcript = step.transcript;
  if (transcript !== null) {
    const facts = [
      transcript.model === null ? null : safe(transcript.model),
      transcript.num_turns === null ? null : `${transcript.num_turns} turn${transcript.num_turns === 1 ? '' : 's'}`,
      transcript.total_calls === null ? null : `${transcript.total_calls} tool call${transcript.total_calls === 1 ? '' : 's'}`,
      transcript.total_cost_usd === null ? null : dollars(transcript.total_cost_usd),
    ].filter((fact): fact is string => fact !== null);
    lines.push(`      transcript (attempt ${transcript.attempt ?? step.attempts.length})${facts.length === 0 ? '' : `: ${facts.join(' · ')}`}`);
    if (transcript.frames_total !== null || transcript.bytes_total !== null) {
      const frames = transcript.frames_total === null ? ''
        : `${thousands(transcript.frames_kept ?? transcript.frames_total)} of ${thousands(transcript.frames_total)} frames`;
      const bytes = transcript.bytes_total === null ? '' : `${thousands(transcript.bytes_total)} bytes`;
      const cut = transcript.truncated ? ', truncated' : '';
      lines.push(`        ${[frames, bytes].filter((part) => part.length > 0).join(', ')}${cut}`);
    }
    if (transcript.tokens_in !== null || transcript.tokens_out !== null) {
      const cache = [
        transcript.cache_read === null ? null : `${thousands(transcript.cache_read)} cache read`,
        transcript.cache_creation === null ? null : `${thousands(transcript.cache_creation)} cache write`,
      ].filter((part): part is string => part !== null);
      lines.push(`        ${thousands(transcript.tokens_in ?? 0)} in / ${thousands(transcript.tokens_out ?? 0)} out`
        + `${cache.length === 0 ? '' : ` · ${cache.join(' · ')}`}`);
    }
    if (transcript.tools.length > 0) {
      lines.push(`        tools: ${transcript.tools.map((tool) =>
        `${safe(tool.name)} ×${tool.calls ?? 0}${tool.errors ? ` (${tool.errors} error${tool.errors === 1 ? '' : 's'})` : ''}`).join(', ')}`);
    }
    for (const call of transcript.last_calls) {
      const excerpt = call.input_excerpt === null ? '' : ` ${safe(call.input_excerpt).slice(0, 120)}`;
      lines.push(`        call ${call.seq ?? '?'} ${safe(call.name)}${excerpt} → ${thousands(call.result_bytes ?? 0)} bytes`);
    }
    lines.push(`        artifacts: ${transcript.artifacts.length === 0
      ? 'none' : transcript.artifacts.slice(0, 10).map(safe).join(', ')}`);
  }
  if (step.sandbox_id.length > 0) lines.push(`      logs: flows logs ${runId} --step ${safe(step.sandbox_id)}`);
  return lines;
}

function renderCloudStatus(run: CloudRunDetail, steps: readonly CloudStep[], now: number): string[] {
  let tokensIn = 0;
  let tokensOut = 0;
  let cost = 0;
  for (const step of steps) {
    tokensIn += step.tokens_in ?? 0;
    tokensOut += step.tokens_out ?? 0;
    cost += step.cost_usd ?? 0;
  }
  // Summed from the step rows, because the run record carries no total. Cloud
  // stores `costUsd` as a float, so this is a float sum — not the exact decimal
  // addition the local journal fold does (run-state.ts `addDollars`). Shown to
  // six places and labelled `spend`, the same word the local view uses.
  const spend = `${thousands(tokensIn)} in / ${thousands(tokensOut)} out / ${dollars(cost)}`;
  const finished = run.completion_reason === null ? '' : `   finished ${safe(run.completion_reason)}`;
  const lines = [
    `RUN ${run.run_id}   ${safe(run.name)}   ${run.status}   started ${ago(run.created_at, now)}${finished}   spend ${spend}`,
    stepCounts(steps),
  ];
  if (run.authority !== null) {
    const facts = [
      run.authority.surface_version === null ? null : `surface ${run.authority.surface_version}`,
      run.authority.artifact_sha256 === null ? null : `artifact ${run.authority.artifact_sha256.slice(0, 12)}`,
      run.authority.source_commit === null ? null : `commit ${run.authority.source_commit.slice(0, 12)}`,
    ].filter((fact): fact is string => fact !== null);
    if (facts.length > 0) lines.push(`authority ${facts.join(' · ')}`);
  }
  if (run.pull_request_url !== null) lines.push(`pr ${run.pull_request_url}`);
  if (run.error !== null) lines.push(`error ${safe(run.error)}`);
  lines.push('');
  const idWidth = Math.max(4, ...steps.map((step) => Math.min(24, step.step_name.length)));
  for (const step of steps) lines.push(...renderStep(step, run.run_id, idWidth));
  return lines;
}

export async function runCloudStatusCli(
  args: { runId?: string; json: boolean },
  io: CliIo,
  options: CloudReadOptions = {},
): Promise<0 | 1 | 2> {
  const env = options.env ?? process.env;
  const now = (options.now ?? Date.now)();
  if (args.runId === undefined || args.runId.length === 0) {
    return fail({
      code: 'run_unknown', exit: 2,
      message: '`flows status --cloud` needs the hosted run id; `flows runs` lists them. '
        + '(Without --cloud the run id defaults to RELAYFLOW_RUN_ID inside a step.)',
    }, args.json, io);
  }
  let run: CloudRunDetail;
  let steps: CloudStep[];
  try {
    run = await getCloudRunDetail(args.runId, options);
    steps = await getCloudRunSteps(args.runId, options);
  } catch (error) {
    return fail(refusalFor(error, `run ${args.runId}`, env), args.json, io);
  }
  const scrubbed: CloudRunDetail = {
    ...run,
    name: redact(run.name, env),
    error: run.error === null ? null : redact(run.error, env),
  };
  const scrubbedSteps = steps.map((step) => ({
    ...step,
    output_summary: step.output_summary === null ? null : redact(step.output_summary, env),
    gate: step.gate === null ? null : { ...step.gate, detail: redact(step.gate.detail, env) },
    transcript: step.transcript === null ? null : {
      ...step.transcript,
      model: step.transcript.model === null ? null : redact(step.transcript.model, env),
      last_calls: step.transcript.last_calls.map((call) => ({
        ...call,
        input_excerpt: call.input_excerpt === null ? null : redact(call.input_excerpt, env),
      })),
      artifacts: step.transcript.artifacts.map((path) => redact(path, env)),
    },
  }));
  if (args.json) {
    io.stdout(canonicalize({ v: 1, ok: true, run: scrubbed, steps: scrubbedSteps, now_ms: now }));
    return 0;
  }
  for (const line of renderCloudStatus(scrubbed, scrubbedSteps, now)) io.stdout(line);
  return 0;
}
