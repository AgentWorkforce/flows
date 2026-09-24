// One journal, folded into the two step shapes Cloud stores for a run.
//
// A hosted run's steps reach Cloud twice: as a *live snapshot* while it runs
// (`POST /runs/<id>/steps/snapshot`) and as the *final report* once it is over
// (`POST /runs/<id>/steps`). The sandbox derives both from `flows status`;
// this module derives them from the same journal fold `flows status` uses
// (`run-state.ts`), so a local run and a hosted one put the same facts in the
// same fields and the dashboard cannot tell which produced a row.
//
// Nothing here does I/O or reads a clock: the caller passes the events and
// `now_ms`, exactly as `foldRunState` does. That is what lets a test fold a
// hand-built journal and assert the exact bytes a push would carry.
//
// ## The bounds are the server's, restated
//
// Every cap below is the one Cloud's own parser enforces
// (`@cloud/core` `storage/step-snapshot.ts` and `storage/step-detail.ts`).
// They are restated rather than imported because this package cannot depend on
// the Cloud app — the same reason `cloud-transcript.ts` restates the
// dashboard's transcript vocabulary. A push that violates one is refused
// whole, so producing a bounded value here is not politeness: it is the
// difference between a run that appears on the dashboard and one that does
// not.
//
// ## Redaction
//
// Every dynamic string goes through `redact` before it is bounded, never
// after: clipping first can leave the head of a secret standing where the
// redactor would have replaced the whole value. Identifier-shaped fields are
// then normalized into the shape Cloud's parser accepts, because the redactor
// emits `[redacted:NAME]`, which no identifier pattern admits.

import { redact } from './redact.js';
import { foldRunState, type RunView, type StepView } from './run-state.js';
import type { JournalEvent } from './journal-reader.js';
import { AUTHORED_STEP_STREAM, foldAuthoredStepRecords } from './authored-step-index.js';

/** Steps one snapshot may carry; a longer run publishes its live tail. */
export const SNAPSHOT_MAX_STEPS = 64;
/** Serialized snapshot envelope cap, against the real UTF-8 byte count. */
export const SNAPSHOT_MAX_BYTES = 64 * 1024;
/** Artifact paths named per step; the rest are counted. */
export const SNAPSHOT_ARTIFACTS_MAX = 5;
export const SNAPSHOT_ARTIFACT_MAX_CHARS = 200;
/** `stepName`, `journalRunId`, `stepType`, `completionReason`, gate, model. */
export const IDENTIFIER_MAX_CHARS = 128;
/** Predecessors one live step lists. */
export const SNAPSHOT_DEPENDS_ON_MAX = 32;
/** Predecessors a final row lists. */
export const DEPENDS_ON_MAX_ENTRIES = 256;
/** The backing columns are PostgreSQL 32-bit integers. */
export const MAX_INT32 = 2_147_483_647;
/** `workflow_steps.display_name`, in code points. */
export const LABEL_MAX_CHARS = 120;
/** `workflow_steps.output_summary`. */
export const OUTPUT_SUMMARY_MAX_CHARS = 1000;
/** `workflow_steps.error`. */
export const ERROR_MAX_CHARS = 1024;
/** Serialized `workflow_steps.detail`. */
export const DETAIL_MAX_BYTES = 16 * 1024;
/** Attempt rows kept on `detail.attempts`; older ones are counted, not listed. */
export const DETAIL_MAX_ATTEMPTS = 20;
/**
 * The one completion reason the kernel uses for success. Cloud keys a step's
 * status off exactly this value, so the live derivation and the final row
 * agree about what "completed" means.
 */
export const SUCCESS_COMPLETION_REASON = 'success';
/** The authored root step spans the whole flow; its children carry the steps. */
export const AUTHORED_ROOT_STEP = 'authored-root';

const IDENTIFIER = /^[A-Za-z0-9_.:/-]+$/u;
const IDENTIFIER_UNSAFE = /[^A-Za-z0-9_.:/-]+/gu;

/** Live kernel states Cloud publishes. A step that has not begun has no honest rendering. */
export type SnapshotState = 'running' | 'backoff' | 'waiting' | 'needs_human' | 'done';

export interface SnapshotStep {
  stepName: string;
  /** Child runs may repeat a step id, so identity is the pair. */
  journalRunId: string;
  stepType: string;
  state: SnapshotState;
  attempt: number;
  elapsedMs: number;
  completionReason?: string;
  gate?: { name: string; verdict: string };
  model?: string;
  turns?: number;
  toolCalls?: number;
  costUsd?: number;
  artifactCount?: number;
  artifacts?: string[];
  label?: string;
  dependsOn?: string[];
}

/** One row of the final report; the field names are `workflow_steps`'s own. */
export interface FinalStep {
  stepName: string;
  stepType: string;
  agent: string;
  preset: string;
  cli: string;
  sandboxId: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  exitCode: number;
  outputSummary: string;
  status: 'completed' | 'failed';
  completionReason: string;
  retryCount: number;
  model?: string;
  tokensInput?: number;
  tokensOutput?: number;
  costUsd?: number;
  error?: string;
  detail?: Record<string, unknown>;
  detailTruncated?: true;
  label?: string;
  dependsOn?: string[];
}

/** One step's per-attempt transcript files, for the `<stepName>/agent.log` upload. */
export interface StepTranscriptRef {
  stepName: string;
  attempts: Array<{ attempt: number; path: string }>;
}

/** What one journal contributes, keyed for the caller's cross-journal cache. */
export interface MirroredJournal {
  runId: string;
  status: RunView['status'];
  terminal: boolean;
  steps: SnapshotStep[];
  finals: FinalStep[];
  transcripts: StepTranscriptRef[];
  /** Child journals this run admitted, from an authored root's step index. */
  children: string[];
  /** Authored graph hints by step id, from an authored root's step index. */
  hints: Map<string, { label?: string; after?: string[] }>;
}

type Payload = Record<string, unknown>;

function record(value: unknown): Payload | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Payload : undefined;
}

function int32(value: unknown, floor = 0): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded < floor) return undefined;
  return Math.min(rounded, MAX_INT32);
}

/**
 * Redact, then normalize, then clip — in that order. Clipping first could
 * leave the head of a secret standing; normalizing first would let a
 * multi-character replacement push the result back over the cap.
 */
export function identifier(
  value: unknown,
  env: NodeJS.ProcessEnv,
  maxChars: number = IDENTIFIER_MAX_CHARS,
): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const clipped = redact(value, env).replace(IDENTIFIER_UNSAFE, '_').slice(0, Math.max(1, maxChars));
  return IDENTIFIER.test(clipped) ? clipped : undefined;
}

/** Free text, redacted then bounded by code points. Empty becomes undefined. */
export function text(value: unknown, env: NodeJS.ProcessEnv, maxChars: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const cleaned = redact(value, env);
  const bounded = [...cleaned].slice(0, maxChars).join('');
  return bounded.length === 0 ? undefined : bounded;
}

/**
 * A step label as `workflow_steps.display_name` accepts it: control characters
 * become spaces, whitespace runs collapse, the result is trimmed and clipped.
 */
export function label(value: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = redact(value, env)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (normalized.length === 0) return undefined;
  return [...normalized].slice(0, LABEL_MAX_CHARS).join('').trimEnd();
}

function snapshotState(state: StepView['state']): SnapshotState | undefined {
  // `pending` and `runnable` are states, but not publishable ones: a step that
  // has not begun is neither completed nor running.
  return state === 'pending' || state === 'runnable' ? undefined : state;
}

/** Cloud's own vocabulary for a live step, derived rather than carried. */
export function snapshotStepStatus(step: Pick<SnapshotStep, 'state' | 'completionReason'>):
'running' | 'completed' | 'failed' {
  if (step.state !== 'done') return 'running';
  return step.completionReason === SUCCESS_COMPLETION_REASON ? 'completed' : 'failed';
}

function snapshotStep(journalRunId: string, step: StepView, env: NodeJS.ProcessEnv): SnapshotStep | undefined {
  const state = snapshotState(step.state);
  if (state === undefined) return undefined;
  const stepName = identifier(step.id, env);
  const journal = identifier(journalRunId, env);
  const stepType = identifier(step.type, env);
  if (stepName === undefined || journal === undefined || stepType === undefined) return undefined;
  const transcript = step.last_attempt?.transcript ?? null;
  const verification = step.last_attempt?.verification ?? null;
  const gateName = verification === null ? undefined : identifier(verification.gate, env);
  const gateVerdict = verification === null ? undefined : identifier(verification.verdict, env);
  const paths = step.artifacts.paths
    .slice(0, SNAPSHOT_ARTIFACTS_MAX)
    .map(path => identifier(path, env, SNAPSHOT_ARTIFACT_MAX_CHARS))
    .filter((path): path is string => path !== undefined);
  const completionReason = identifier(step.completion_reason ?? step.last_attempt?.completion_reason, env);
  const cost = transcript?.total_cost_usd;
  return {
    stepName,
    journalRunId: journal,
    stepType,
    state,
    attempt: int32(step.attempt) ?? 0,
    elapsedMs: int32(step.elapsed_ms) ?? 0,
    ...(completionReason === undefined ? {} : { completionReason }),
    ...(gateName === undefined || gateVerdict === undefined ? {} : { gate: { name: gateName, verdict: gateVerdict } }),
    ...(identifier(transcript?.model, env) === undefined ? {} : { model: identifier(transcript?.model, env)! }),
    ...(int32(transcript?.num_turns) === undefined ? {} : { turns: int32(transcript?.num_turns)! }),
    ...(int32(transcript?.tool_calls) === undefined ? {} : { toolCalls: int32(transcript?.tool_calls)! }),
    ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}),
    ...(step.artifacts.journaled ? { artifactCount: int32(step.artifacts.paths.length) ?? 0 } : {}),
    ...(paths.length === 0 ? {} : { artifacts: paths }),
  };
}

function isoAt(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const at = new Date(ms);
  return Number.isNaN(at.getTime()) ? '' : at.toISOString();
}

/**
 * The bounded `workflow_steps.detail` for one step: the attempt's journaled
 * transcript digest, plus the attempt roster. The digest is already redacted
 * and bounded where the worker wrote it (`agent-transcript.ts`); it is
 * re-bounded here because this process, not that one, is what Cloud's parser
 * will judge.
 */
function stepDetail(
  attempts: AttemptRecord[],
  env: NodeJS.ProcessEnv,
): { detail?: Record<string, unknown>; truncated?: true } {
  const last = attempts.at(-1);
  const digest = record(record(last?.trajectoryTail)?.['transcript']);
  const roster = attempts.slice(-DETAIL_MAX_ATTEMPTS).map(entry => ({
    attempt: entry.attempt,
    atMs: entry.atMs,
    completionReason: identifier(entry.completionReason, env) ?? 'unknown',
    ...(identifier(entry.disposition, env) === undefined ? {} : { disposition: identifier(entry.disposition, env)! }),
    ...(entry.transcriptBytes === undefined ? {} : { transcriptBytes: entry.transcriptBytes }),
  }));
  if (digest === undefined && roster.length <= 1) return {};
  // The digest carries a sandbox-free copy of the transcript's facts. `file`
  // names a path on *this* machine, which is neither useful to a reader of the
  // dashboard nor something to publish; the byte counts beside it are.
  const file = record(digest?.['file']);
  const detail: Record<string, unknown> = {
    ...(digest === undefined ? {} : {
      transcript: {
        ...digest,
        ...(file === undefined ? {} : {
          file: Object.fromEntries(Object.entries(file).filter(([key]) => key !== 'path')),
        }),
      },
    }),
    ...(roster.length === 0 ? {} : { attempts: roster }),
    ...(attempts.length > roster.length ? { attemptsOmitted: attempts.length - roster.length } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(detail), 'utf8') <= DETAIL_MAX_BYTES) return { detail };
  // Over the cap: drop the transcript's free text and its tool roster — the
  // largest fields by far — and say the detail was cut rather than dropping it
  // whole, which would take the attempt history with it.
  const transcript = record(detail['transcript']);
  const reduced: Record<string, unknown> = {
    ...(transcript === undefined ? {} : {
      transcript: Object.fromEntries(
        Object.entries(transcript).filter(([key]) => key === 'attempt' || key === 'exit_code'
          || key === 'file' || key === 'result'),
      ),
    }),
    ...(roster.length === 0 ? {} : { attempts: roster }),
  };
  if (Buffer.byteLength(JSON.stringify(reduced), 'utf8') <= DETAIL_MAX_BYTES) {
    return { detail: reduced, truncated: true };
  }
  return { detail: { attempts: roster.slice(-1) }, truncated: true };
}

interface AttemptRecord {
  attempt: number;
  atMs: number;
  completionReason: string;
  disposition: string;
  trajectoryTail: unknown;
  transcriptBytes?: number;
  transcriptPath?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
}

/**
 * Every `step.completed` the journal holds, in order, by step id.
 *
 * `foldRunState` keeps only the *last* attempt, because that is what a status
 * view shows. The final report's `detail.attempts` is the whole roster, and
 * its token totals are the sum across attempts, so both need the raw entries.
 */
function attemptsByStep(events: readonly JournalEvent[]): Map<string, AttemptRecord[]> {
  const byStep = new Map<string, AttemptRecord[]>();
  for (const event of events) {
    if (event.entry_type !== 'step.completed' || event.step_id === null) continue;
    const payload = record(event.payload) ?? {};
    const budget = record(payload['budget']) ?? {};
    const digest = record(record(payload['trajectory_tail'])?.['transcript']);
    const file = record(digest?.['file']);
    const result = record(digest?.['result']);
    const entries = byStep.get(event.step_id) ?? [];
    entries.push({
      attempt: event.attempt ?? entries.length + 1,
      atMs: event.at_ms,
      completionReason: typeof payload['completionReason'] === 'string' ? payload['completionReason'] : 'unknown',
      disposition: typeof payload['disposition'] === 'string' ? payload['disposition'] : 'unknown',
      trajectoryTail: payload['trajectory_tail'],
      ...(int32(file?.['bytes_kept']) === undefined ? {} : { transcriptBytes: int32(file?.['bytes_kept'])! }),
      ...(typeof file?.['path'] === 'string' ? { transcriptPath: file['path'] } : {}),
      ...(int32(budget['tokens_in']) === undefined ? {} : { tokensIn: int32(budget['tokens_in'])! }),
      ...(int32(budget['tokens_out']) === undefined ? {} : { tokensOut: int32(budget['tokens_out'])! }),
      ...(typeof result?.['total_cost_usd'] === 'number' && Number.isFinite(result['total_cost_usd'])
        && result['total_cost_usd'] >= 0
        ? { costUsd: result['total_cost_usd'] as number } : {}),
    });
    byStep.set(event.step_id, entries);
  }
  return byStep;
}

function finalStep(
  step: StepView,
  attempts: AttemptRecord[],
  env: NodeJS.ProcessEnv,
): FinalStep | undefined {
  const stepName = identifier(step.id, env);
  const stepType = identifier(step.type, env);
  if (stepName === undefined || stepType === undefined) return undefined;
  const completionReason = step.completion_reason ?? step.last_attempt?.completion_reason ?? 'unknown';
  const succeeded = completionReason === SUCCESS_COMPLETION_REASON;
  const transcript = step.last_attempt?.transcript ?? null;
  const startMs = step.started_at_ms;
  const endMs = step.last_attempt?.ended_at_ms ?? null;
  const duration = startMs !== null && endMs !== null ? Math.max(0, endMs - startMs) : (step.elapsed_ms ?? 0);
  const tokensIn = attempts.reduce((total, entry) => total + (entry.tokensIn ?? 0), 0);
  const tokensOut = attempts.reduce((total, entry) => total + (entry.tokensOut ?? 0), 0);
  const failure = transcript?.failure ?? null;
  // Summed across attempts, exactly as the tokens above are. Taking the last
  // attempt's figure while summing its tokens was inconsistent in itself, and
  // Cloud totals these rows for the run's spend — so a retried agent's earlier
  // charges simply vanished from the run.
  const spentUsd = attempts.reduce((total, entry) => total + (entry.costUsd ?? 0), 0);
  const detail = stepDetail(attempts, env);
  const verification = step.last_attempt?.verification ?? null;
  // What the step said about itself. A gate's verdict detail is the nearest
  // thing a deterministic step has to an agent's final message; an agent step
  // has neither in the status view, so the completion reason stands alone
  // rather than being invented.
  const summary = text(verification?.detail, env, OUTPUT_SUMMARY_MAX_CHARS)
    ?? `step ${succeeded ? 'completed' : 'ended'}: ${identifier(completionReason, env) ?? 'unknown'}`;
  const model = identifier(transcript?.model, env);
  const error = succeeded ? undefined : text(failure?.excerpt, env, ERROR_MAX_CHARS);
  return {
    stepName,
    stepType,
    // Cloud's legacy v1 columns. The kernel has no agent/preset/CLI identity
    // per step, and an empty string is the honest answer the hosted v2
    // executor gives too — never a guess that would render as a real name.
    agent: '',
    preset: '',
    cli: '',
    // Named after the uploaded transcript object once one is written, exactly
    // as the sandbox does; empty until then, never a fabricated sandbox id.
    sandboxId: '',
    startTime: isoAt(startMs),
    endTime: isoAt(endMs),
    durationMs: int32(duration) ?? 0,
    exitCode: succeeded ? 0 : 1,
    outputSummary: summary,
    status: succeeded ? 'completed' : 'failed',
    completionReason: identifier(completionReason, env) ?? 'unknown',
    retryCount: Math.max(0, attempts.length - 1),
    ...(model === undefined ? {} : { model }),
    ...(tokensIn > 0 ? { tokensInput: Math.min(tokensIn, MAX_INT32) } : {}),
    ...(tokensOut > 0 ? { tokensOutput: Math.min(tokensOut, MAX_INT32) } : {}),
    ...(spentUsd > 0 ? { costUsd: spentUsd } : {}),
    ...(error === undefined ? {} : { error }),
    ...(detail.detail === undefined ? {} : { detail: detail.detail }),
    ...(detail.truncated === undefined ? {} : { detailTruncated: detail.truncated }),
  };
}

/** Per-attempt transcript files this step left on disk, in attempt order. */
function transcriptRef(stepName: string, attempts: AttemptRecord[]): StepTranscriptRef | undefined {
  const files = attempts
    .filter((entry): entry is AttemptRecord & { transcriptPath: string } => entry.transcriptPath !== undefined)
    .map(entry => ({ attempt: entry.attempt, path: entry.transcriptPath }));
  return files.length === 0 ? undefined : { stepName, attempts: files };
}

/**
 * Fold one journal into everything the mirror can say about it.
 *
 * The authored root is deliberately not published as a step: it spans the
 * whole flow, so a snapshot carrying it would show one node called
 * `authored-root` sitting at 100% for the run's entire duration beside the
 * steps that actually did the work. Its journal is still read, for the step
 * index that names the child journals and their graph edges.
 */
export function mirrorJournal(
  runId: string,
  events: readonly JournalEvent[],
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
): MirroredJournal {
  const view = foldRunState(events, nowMs);
  const attempts = attemptsByStep(events);
  const steps: SnapshotStep[] = [];
  const finals: FinalStep[] = [];
  const transcripts: StepTranscriptRef[] = [];
  for (const step of view.steps) {
    if (step.id === AUTHORED_ROOT_STEP) continue;
    const live = snapshotStep(runId, step, env);
    if (live !== undefined) steps.push(live);
    const stepAttempts = attempts.get(step.id) ?? [];
    if (step.state === 'done') {
      const row = finalStep(step, stepAttempts, env);
      if (row !== undefined) {
        finals.push(row);
        const ref = transcriptRef(row.stepName, stepAttempts);
        if (ref !== undefined) transcripts.push(ref);
      }
    }
  }
  const index = authoredIndex(events, env);
  // A declarative flow declares its edges in the spec, not in an authored-step
  // stream — so a YAML run had no hints at all and drew every node
  // unconnected. Read them from `run.spawned`, keyed the same way, and let the
  // authored index win where both exist (an authored root's index is the
  // richer record, and carries labels too).
  const declared = declaredEdges(runId, events, env);
  for (const [key, hint] of declared) {
    if (!index.hints.has(key)) index.hints.set(key, hint);
  }
  return {
    runId,
    status: view.status,
    terminal: view.status === 'completed' || view.status === 'failed' || view.status === 'cancelled',
    steps,
    finals,
    transcripts,
    children: index.children,
    hints: index.hints,
  };
}

/**
 * An authored root's step index: which child journal runs each authored step,
 * what the author called it, and what it came after.
 *
 * This is the only place those facts exist. A child journal's own view knows
 * its kernel step ids and nothing about the authored graph above it, so
 * without the root's index a mirrored authored run would show its steps with
 * no names and no edges — which is exactly what the run graph draws from.
 */
function authoredIndex(
  events: readonly JournalEvent[],
  env: NodeJS.ProcessEnv,
): { children: string[]; hints: Map<string, { label?: string; after?: string[] }> } {
  const messages: unknown[] = [];
  for (const event of events) {
    if (event.entry_type !== 'stream.appended') continue;
    const payload = record(event.payload);
    if (payload?.['stream'] === AUTHORED_STEP_STREAM) messages.push(payload['message']);
  }
  const children: string[] = [];
  const hints = new Map<string, { label?: string; after?: string[] }>();
  for (const entry of foldAuthoredStepRecords(messages).values()) {
    if (/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(entry.runId)) children.push(entry.runId);
    const name = label(entry.label, env);
    const after = entry.after === undefined
      ? undefined
      : [...entry.after]
        .slice(0, DEPENDS_ON_MAX_ENTRIES)
        .map(value => identifier(value, env))
        .filter((value): value is string => value !== undefined);
    if (name === undefined && after === undefined) continue;
    hints.set(`${entry.runId}/${entry.step}`, {
      ...(name === undefined ? {} : { label: name }),
      ...(after === undefined ? {} : { after }),
    });
  }
  return { children, hints };
}

/**
 * The `depends_on` a declarative spec declares, as graph hints.
 *
 * `foldRunState` reads these to decide readiness but does not surface them on
 * `StepView`, and deliberately: `flows status --json` is a pinned shape. So
 * they are read here, straight off the `run.spawned` payload this fold already
 * has in hand, rather than by widening a view other readers depend on.
 */
function declaredEdges(
  runId: string,
  events: readonly JournalEvent[],
  env: NodeJS.ProcessEnv,
): Map<string, { after?: string[] }> {
  const hints = new Map<string, { after?: string[] }>();
  const spawned = events.find(event => event.entry_type === 'run.spawned');
  const steps = record(spawned?.payload)?.['spec'];
  const declared = record(steps)?.['steps'];
  if (!Array.isArray(declared)) return hints;
  for (const entry of declared) {
    const step = record(entry);
    const id = identifier(step?.['id'], env);
    if (id === undefined) continue;
    const raw = step?.['depends_on'] ?? step?.['dependsOn'];
    if (!Array.isArray(raw)) continue;
    const after = raw
      .slice(0, DEPENDS_ON_MAX_ENTRIES)
      .map(value => identifier(value, env))
      .filter((value): value is string => value !== undefined);
    hints.set(`${runId}/${id}`, { after });
  }
  return hints;
}

/**
 * Build a snapshot envelope that actually fits both bounds.
 *
 * The count cap applies unconditionally — 65 tiny steps are 65 steps. Only
 * then does the byte cap bite: first the artifact *names* go (their count
 * survives), then the `dependsOn` edges, then whole entries from the head of
 * the display order, because the tail is the newest work and that is what a
 * live view exists to show. A capped view announces itself as incomplete;
 * silently showing fewer steps than ran is the one thing it must not do.
 */
export function fitSnapshot(
  steps: readonly SnapshotStep[],
  envelope: { sequence: number; capturedAt: string; alreadyOmitted?: number },
): { sequence: number; capturedAt: string; truncated?: true; omittedStepCount?: number; steps: SnapshotStep[] } {
  let kept = [...steps];
  let omitted = envelope.alreadyOmitted ?? 0;
  let truncated = omitted > 0;
  if (kept.length > SNAPSHOT_MAX_STEPS) {
    omitted += kept.length - SNAPSHOT_MAX_STEPS;
    kept = kept.slice(kept.length - SNAPSHOT_MAX_STEPS);
    truncated = true;
  }
  const build = (): { sequence: number; capturedAt: string; truncated?: true; omittedStepCount?: number; steps: SnapshotStep[] } => ({
    sequence: envelope.sequence,
    capturedAt: envelope.capturedAt,
    ...(truncated ? { truncated: true as const } : {}),
    ...(omitted > 0 ? { omittedStepCount: Math.min(omitted, MAX_INT32) } : {}),
    steps: kept,
  });
  const bytes = (): number => Buffer.byteLength(JSON.stringify(build()), 'utf8');
  if (bytes() <= SNAPSHOT_MAX_BYTES) return build();
  kept = kept.map(({ artifacts: _artifacts, ...step }) => step);
  truncated = true;
  if (bytes() <= SNAPSHOT_MAX_BYTES) return build();
  kept = kept.map(({ dependsOn: _dependsOn, ...step }) => step);
  if (bytes() <= SNAPSHOT_MAX_BYTES) return build();
  while (kept.length > 1 && bytes() > SNAPSHOT_MAX_BYTES) {
    kept = kept.slice(1);
    omitted += 1;
  }
  return build();
}

/** Apply an authored root's graph hints to a step, bounded for the live view. */
export function withGraphHints<T extends { stepName: string; journalRunId?: string }>(
  step: T,
  hints: Map<string, { label?: string; after?: string[] }>,
  journalRunId: string,
  maxDependsOn: number,
  knownSteps: ReadonlySet<string>,
): T & { label?: string; dependsOn?: string[] } {
  const hint = hints.get(`${journalRunId}/${step.stepName}`);
  if (hint === undefined) return step;
  // Only predecessors that are themselves steps of this report: an edge to a
  // node the graph does not contain draws nothing and reads as data loss.
  const after = hint.after
    ?.filter(name => name !== step.stepName && knownSteps.has(name))
    .slice(0, maxDependsOn);
  return {
    ...step,
    ...(hint.label === undefined ? {} : { label: hint.label }),
    ...(after === undefined ? {} : { dependsOn: after }),
  };
}

export type { RunView };
