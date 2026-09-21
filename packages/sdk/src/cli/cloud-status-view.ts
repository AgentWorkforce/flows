// The `flows status --cloud` page: one run record and its step rows, rendered
// in the grammar `cli/status.ts` already uses for a local run.
//
// Moved out of `cli/cloud-read.ts` so the one-shot read and the watched read
// (cli/cloud-live.ts) draw the identical page through the identical scrubber.
// A watched frame that redacted differently to the page it replaces would be
// a leak nobody could see from either file alone.
//
// Live rows are the part this view has that the local one does not have to
// think about: Cloud's step snapshot is the only evidence, and where it is
// silent the row stays silent. An elapsed time is derived only for a step that
// is demonstrably running, an attempt number is printed only where the
// snapshot establishes one, and neither a maximum-attempt denominator nor a
// wait id is invented — Cloud's step rows carry neither.

import { isCloudRunActive } from '../cloud-run-record.js';
import { redact } from '../redact.js';
import type { CloudRunDetail, CloudStep } from '../cloud-read.js';
import { ago, dollars, errorLines, safe, thousands } from './cloud-format.js';
import { formatDuration } from './status.js';

const GLYPH: Record<string, string> = {
  completed: '✓', succeeded: '✓', failed: '✗', cancelled: '✗',
  running: '↻', backoff: '↻', waiting: '⏸', needs_human: '⏸',
  pending: '○', queued: '○',
};

/**
 * Step statuses that mean the step is in flight, in the local view's
 * vocabulary (`cli/status.ts`). These are the rows with no `durationMs` and no
 * `endTime`: their timing has to be derived, and their attempt number is the
 * one being attempted rather than a count of the ones that finished.
 */
const ACTIVE_STEP_STATUSES: readonly string[] = ['running', 'backoff', 'waiting', 'needs_human'];

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

/**
 * How long an in-flight step has been in flight.
 *
 * Only from a start timestamp the row actually carries, and only while the row
 * says the step has not ended: a finished step whose `endTime` is missing keeps
 * whatever duration Cloud reported rather than being advanced to now, which
 * would make a step that ended an hour ago look like it is still burning. A
 * start in the future is clock skew between Cloud and here, not negative time,
 * so it clamps to zero.
 */
function liveElapsed(step: CloudStep, now: number): number | null {
  if (!ACTIVE_STEP_STATUSES.includes(step.status) || step.ended_at !== null || step.started_at === null) return null;
  const started = Date.parse(step.started_at);
  return Number.isFinite(started) ? Math.max(0, now - started) : null;
}

/**
 * The attempt cell.
 *
 * A finished step counts the attempt records Cloud kept. An in-flight step
 * wants the number of the attempt *now running*, and `attempts` cannot supply
 * it: those entries are completion records, so during a second attempt the
 * array still holds one entry and would print `attempt 1`. `retryCount` plus
 * one is that number — but only where the row also shows the step was
 * dispatched, because a row with no start timestamp has not attempted
 * anything and `attempt 1` would be a claim about work that has not begun.
 * Where neither establishes it, the cell is omitted: the local view prints no
 * attempt at zero either. No `/max` denominator — Cloud's step rows carry no
 * maximum, and printing one would invent a budget.
 */
function attemptCell(step: CloudStep): string | null {
  if (!ACTIVE_STEP_STATUSES.includes(step.status)) {
    const attempts = step.attempts.length;
    return attempts > 0 ? `${attempts} attempt${attempts === 1 ? '' : 's'}` : null;
  }
  if (step.retry_count === null || step.started_at === null) return null;
  return `attempt ${Math.max(0, Math.trunc(step.retry_count)) + 1}`;
}

function renderStep(step: CloudStep, runId: string, idWidth: number, now: number): string[] {
  const cells = [
    safe(step.step_name).slice(0, 24).padEnd(idWidth),
    step.step_type.padEnd(13),
    step.status.padEnd(11),
  ];
  const attempt = attemptCell(step);
  if (attempt !== null) cells.push(attempt);
  const elapsed = step.duration_ms ?? liveElapsed(step, now);
  if (elapsed !== null) cells.push(formatDuration(elapsed));
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

export function renderCloudStatus(run: CloudRunDetail, steps: readonly CloudStep[], now: number): string[] {
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
  // `steps 0` alone reads as "this run has no steps", which is a claim about
  // the run. For a run that is still going it is a fact about the snapshot:
  // Cloud served no rows, this time.
  if (steps.length === 0 && isCloudRunActive(run.status)) lines.push('No step snapshot available yet.');
  if (run.authority !== null) {
    const facts = [
      run.authority.surface_version === null ? null : `surface ${run.authority.surface_version}`,
      run.authority.artifact_sha256 === null ? null : `artifact ${run.authority.artifact_sha256.slice(0, 12)}`,
      run.authority.source_commit === null ? null : `commit ${run.authority.source_commit.slice(0, 12)}`,
    ].filter((fact): fact is string => fact !== null);
    if (facts.length > 0) lines.push(`authority ${facts.join(' · ')}`);
  }
  if (run.pull_request_url !== null) lines.push(`pr ${run.pull_request_url}`);
  if (run.error !== null) lines.push('error', ...errorLines(run.error, '  '));
  lines.push('');
  const idWidth = Math.max(4, ...steps.map((step) => Math.min(24, step.step_name.length)));
  for (const step of steps) lines.push(...renderStep(step, run.run_id, idWidth, now));
  return lines;
}

/** Every free-text field of the run record, through the status page's redactor. */
export function scrubRun(run: CloudRunDetail, env: NodeJS.ProcessEnv): CloudRunDetail {
  return {
    ...run,
    name: redact(run.name, env),
    error: run.error === null ? null : redact(run.error, env),
  };
}

/** The same, for the step rows — including every string inside the digest. */
export function scrubSteps(steps: readonly CloudStep[], env: NodeJS.ProcessEnv): CloudStep[] {
  return steps.map((step) => ({
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
}
