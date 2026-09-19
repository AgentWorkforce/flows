// Pure fold of a run's journal into the view `flows status` renders.
//
// Mirrors the kernel's `RunState::fold` (kernel/relayflowd-core/src/state.rs)
// transition for transition, but keeps only what a status view needs: step
// state, attempt, lease, backoff, wait, the last completion's verdict, and
// spend. Nothing here reads a prompt, an input binding, an output body, a
// wake context or a pin — the model has no field for them, so their absence
// from the rendered view is structural rather than a matter of care.
//
// No I/O, no clock: the caller passes `now_ms`, so a test folds a hand-built
// journal against a fixed instant and asserts exact elapsed and overdue values.

import type { JournalEvent } from './journal-reader.js';

export type RunStatus = 'running' | 'parked' | 'completed' | 'failed' | 'cancelling' | 'cancelled';

/** `StepState` variant names from state.rs, snake_case. */
export type StepStateName = 'pending' | 'runnable' | 'running' | 'backoff' | 'waiting' | 'needs_human' | 'done';

export interface Spend {
  tokens_in: number;
  tokens_out: number;
  /** Decimal string, as the journal stores it; never a float. */
  dollars: string;
  dollars_unmetered: boolean;
}

export interface StepCounts {
  total: number;
  done: number;
  running: number;
  /** `pending` and `runnable` both: neither has started an attempt. */
  pending: number;
  backoff: number;
  waiting: number;
  needs_human: number;
}

/**
 * The part of the attempt's journaled transcript digest (flows#491, written to
 * `trajectory_tail.transcript`) that a status view shows. Not the whole digest:
 * the tool roster and per-call excerpts are the transcript file's job, and this
 * view has to stay small and greppable. Every string here was redacted when the
 * digest was built and is redacted again on the way out.
 */
export interface AttemptTranscript {
  /** Where the full per-attempt transcript is, so a reader can go and open it. */
  path: string | null;
  bytes: number | null;
  truncated: boolean;
  model: string | null;
  num_turns: number | null;
  total_cost_usd: number | null;
  tool_calls: number | null;
  /** Why the attempt failed, as the digest recorded it; already bounded. */
  failure: { kind: string; excerpt: string } | null;
}

export interface LastAttempt {
  attempt: number;
  completion_reason: string;
  disposition: string;
  verification: { gate: string; verdict: string; detail: string } | null;
  human_intervention: boolean;
  /** Count only; the refs carry surface paths and idempotency keys. */
  effects: number;
  ended_at_ms: number;
  /** Null when the attempt journaled no digest — an llm step, or a pre-#491 run. */
  transcript: AttemptTranscript | null;
}

export interface StepView {
  id: string;
  type: string;
  state: StepStateName;
  attempt: number;
  max_iterations: number | null;
  started_at_ms: number | null;
  elapsed_ms: number | null;
  lease: { deadline_ms: number; overdue_ms: number } | null;
  backoff_until_ms: number | null;
  wait: { wait_id: string; kind: 'human' | 'event' | 'timer'; timeout_at_ms: number | null } | null;
  last_attempt: LastAttempt | null;
  /**
   * Why this step finished, once it is `done`. Separate from `last_attempt`
   * because an epoch summary carries `steps_done[id].completionReason`
   * (kernel `entry.rs` `StepDoneSummary`) but no attempt record — so after a
   * compaction this is the only place the fact survives. Dependency readiness
   * and the failure glyph both read this, never `last_attempt`.
   */
  completion_reason: string | null;
  /** Paths the worker journaled for the last attempt, when its output carried them. */
  artifacts: { paths: string[]; journaled: boolean };
}

export interface RunView {
  run_id: string;
  name: string;
  status: RunStatus;
  completion_reason: string | null;
  spawned_at_ms: number;
  now_ms: number;
  spend: Spend;
  counts: StepCounts;
  steps: StepView[];
}

export class RunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunStateError';
  }
}

type Payload = Record<string, unknown>;

function payloadOf(event: JournalEvent): Payload {
  return event.payload !== null && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload as Payload : {};
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Sum two decimal dollar strings exactly, at whatever scale they carry — the
 * kernel's budget fold (`relayflowd-core/src/state/budget.rs`) aligns every
 * fractional digit before adding, and it accepts arbitrary precision. Scaling
 * to a fixed six fractional digits dropped a charge of `0.0000001` to zero, so
 * `flows status` underreported spend the kernel had totalled exactly.
 *
 * A value that is not a decimal number is left out of the sum rather than
 * counted as zero, and the caller is told by `malformed`.
 */
export function addDollars(left: string, right: string): string {
  const parsed = [left, right].map((value) => /^\d+(?:\.\d+)?$/.test(value) ? value : null);
  const usable = parsed.filter((value): value is string => value !== null);
  if (usable.length === 0) return '0';
  if (usable.length === 1) return normalizeDollars(usable[0]!);
  const scale = Math.max(...usable.map((value) => (value.split('.')[1] ?? '').length));
  const scaled = usable.map((value) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
  });
  return fromScaled(scaled[0]! + scaled[1]!, scale);
}

/** `12.3400` -> `12.34`, `0.000` -> `0`; the journal's own spelling otherwise. */
function normalizeDollars(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  return fromScaled(BigInt(`${whole}${fraction}`), fraction.length);
}

function fromScaled(total: bigint, scale: number): string {
  if (scale === 0) return String(total);
  const digits = String(total).padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

/**
 * Reduce `trajectory_tail.transcript` (the digest flows#491 journals) to the
 * handful of facts a status view shows. Every field is taken defensively: the
 * journal is evidence written by a worker that may predate this reader, so a
 * missing or wrong-typed field becomes null rather than throwing.
 */
function attemptTranscript(trajectoryTail: unknown): AttemptTranscript | null {
  // Arrays are objects too, and a malformed digest is exactly the shape that
  // would otherwise reach the view as `{ kind: 'unknown', excerpt: '' }`.
  const object = (value: unknown): Payload | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Payload : null;
  const digest = object(object(trajectoryTail)?.['transcript']);
  if (digest === null) return null;
  const file = object(digest['file']) ?? {};
  const result = object(digest['result']) ?? {};
  const tools = object(digest['tools']) ?? {};
  const failure = object(digest['failure']);
  return {
    path: typeof file['path'] === 'string' ? file['path'] : null,
    bytes: integer(file['bytes_kept']),
    truncated: file['truncated'] === true,
    model: typeof result['model'] === 'string' ? result['model'] : null,
    num_turns: integer(result['num_turns']),
    total_cost_usd: typeof result['total_cost_usd'] === 'number' && Number.isFinite(result['total_cost_usd'])
      ? result['total_cost_usd'] : null,
    tool_calls: integer(tools['total_calls']),
    failure: failure === null ? null : {
      kind: text(failure['kind'], 'unknown'),
      excerpt: text(failure['excerpt']),
    },
  };
}

function addSpend(total: Spend, charge: unknown): Spend {
  const budget = charge !== null && typeof charge === 'object' ? charge as Payload : {};
  return {
    tokens_in: total.tokens_in + (integer(budget['tokens_in']) ?? 0),
    tokens_out: total.tokens_out + (integer(budget['tokens_out']) ?? 0),
    dollars: addDollars(total.dollars, text(budget['dollars'], '0')),
    dollars_unmetered: total.dollars_unmetered || budget['dollars_unmetered'] === true,
  };
}

const ZERO_SPEND: Spend = { tokens_in: 0, tokens_out: 0, dollars: '0', dollars_unmetered: false };

interface StepFold {
  view: StepView;
  depends_on: string[];
}

function freshStep(id: string, type: string, maxIterations: number | null, dependsOn: string[]): StepFold {
  return {
    depends_on: dependsOn,
    view: {
      id, type, state: 'pending', attempt: 0, max_iterations: maxIterations,
      started_at_ms: null, elapsed_ms: null, lease: null, backoff_until_ms: null, wait: null,
      last_attempt: null, completion_reason: null, artifacts: { paths: [], journaled: false },
    },
  };
}

/** Leave the transient facts of one state behind when entering another. */
function enter(view: StepView, state: StepStateName): void {
  view.state = state;
  view.lease = null;
  view.backoff_until_ms = null;
  view.wait = null;
}

function artifactsOf(output: unknown): { paths: string[]; journaled: boolean } {
  // worker.ts journals `artifacts` inside the CliResult wrapper only when the
  // agent's stdout was not a JSON object; on the JSON path the author's
  // object is the output and carries no such key.
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return { paths: [], journaled: false };
  const paths = (output as Payload)['artifacts'];
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === 'string')) return { paths: [], journaled: false };
  return { paths: [...paths as string[]], journaled: true };
}

/**
 * Fold journal events, in sequence order, into a {@link RunView} as of
 * `now_ms`. Throws {@link RunStateError} on a journal the kernel would also
 * refuse (no `run.spawned` first, an unknown step).
 */
export function foldRunState(events: readonly JournalEvent[], now_ms: number): RunView {
  const first = events[0];
  if (first === undefined || first.entry_type !== 'run.spawned') {
    throw new RunStateError('Journal does not begin with run.spawned.');
  }
  const spawned = payloadOf(first);
  const spec = spawned['spec'] !== null && typeof spawned['spec'] === 'object' ? spawned['spec'] as Payload : {};
  const declared = Array.isArray(spec['steps']) ? spec['steps'] as unknown[] : [];
  const steps = new Map<string, StepFold>();
  for (const entry of declared) {
    const step = entry !== null && typeof entry === 'object' ? entry as Payload : {};
    const id = text(step['id']);
    if (id.length === 0) throw new RunStateError('Spec step without an id.');
    const dependsOn = Array.isArray(step['depends_on']) ? (step['depends_on'] as unknown[]).filter((d): d is string => typeof d === 'string') : [];
    steps.set(id, freshStep(id, text(step['type'], 'unknown'), integer(step['max_iterations']), dependsOn));
  }
  const budget = spec['budget'] !== null && typeof spec['budget'] === 'object' ? spec['budget'] as Payload : {};
  // An authored child run carries its parent's totals so ceilings hold across
  // the family (state.rs `prior_spend`); the view reports the same running total.
  let spend = addSpend(ZERO_SPEND, budget['prior_spend']);
  let completion: string | null = null;
  let cancelRequested = false;

  const stepOf = (event: JournalEvent): StepView => {
    if (event.step_id === null) throw new RunStateError(`Entry seq ${event.seq} (${event.entry_type}) names no step.`);
    const step = steps.get(event.step_id);
    if (step === undefined) throw new RunStateError(`Entry seq ${event.seq} names unknown step ${JSON.stringify(event.step_id)}.`);
    return step.view;
  };

  for (const event of events.slice(1)) {
    const payload = payloadOf(event);
    switch (event.entry_type) {
      case 'step.attempt.started': {
        const view = stepOf(event);
        const attempt = event.attempt ?? view.attempt;
        view.attempt = Math.max(view.attempt, attempt);
        view.max_iterations = integer(payload['max_iterations']) ?? view.max_iterations;
        view.started_at_ms = event.at_ms;
        enter(view, 'running');
        const deadline = integer(payload['lease_deadline_ms']) ?? event.at_ms;
        view.lease = { deadline_ms: deadline, overdue_ms: 0 };
        break;
      }
      case 'step.completed': {
        const view = stepOf(event);
        const attempt = event.attempt ?? view.attempt;
        view.attempt = Math.max(view.attempt, attempt);
        spend = addSpend(spend, payload['budget']);
        const verification = payload['verification'] !== null && typeof payload['verification'] === 'object'
          ? payload['verification'] as Payload : undefined;
        view.last_attempt = {
          attempt,
          completion_reason: text(payload['completionReason'], 'unknown'),
          disposition: text(payload['disposition'], 'unknown'),
          verification: verification === undefined ? null : {
            gate: text(verification['gate']), verdict: text(verification['verdict']), detail: text(verification['detail']),
          },
          human_intervention: payload['human_intervention'] === true,
          effects: Array.isArray(payload['effects']) ? payload['effects'].length : 0,
          ended_at_ms: event.at_ms,
          transcript: attemptTranscript(payload['trajectory_tail']),
        };
        view.artifacts = artifactsOf(payload['output']);
        const disposition = payload['disposition'];
        if (disposition === 'retry') {
          enter(view, 'backoff');
          view.backoff_until_ms = integer(payload['next_attempt_at_ms']) ?? event.at_ms;
        } else if (disposition === 'park') {
          enter(view, 'needs_human');
          view.wait = { wait_id: `park-${view.id}-${attempt}`, kind: 'human', timeout_at_ms: null };
        } else {
          enter(view, 'done');
          view.completion_reason = view.last_attempt.completion_reason;
        }
        break;
      }
      case 'sleep.until': {
        const view = stepOf(event);
        enter(view, 'backoff');
        view.backoff_until_ms = integer(payload['wake_at_ms']) ?? event.at_ms;
        break;
      }
      case 'wait.event': {
        const view = stepOf(event);
        enter(view, 'waiting');
        view.wait = { wait_id: text(payload['wait_id']), kind: 'event', timeout_at_ms: integer(payload['timeout_at_ms']) };
        break;
      }
      case 'wait.human': {
        const view = stepOf(event);
        enter(view, 'needs_human');
        view.wait = { wait_id: text(payload['wait_id']), kind: 'human', timeout_at_ms: integer(payload['timeout_at_ms']) };
        break;
      }
      case 'wait.completed': {
        const view = stepOf(event);
        if (payload['completionReason'] === 'canceled') {
          enter(view, 'done');
          view.last_attempt = view.last_attempt ?? {
            attempt: view.attempt, completion_reason: 'canceled', disposition: 'step_done',
            verification: null, human_intervention: false, effects: 0, ended_at_ms: event.at_ms,
            transcript: null,
          };
          view.completion_reason = 'canceled';
        } else {
          enter(view, 'runnable');
        }
        break;
      }
      case 'epoch.summary': {
        // A new epoch restarts every step (state.rs `apply_epoch`); the
        // summary then restores the ones it carries forward.
        for (const step of steps.values()) {
          const { id, type, max_iterations } = step.view;
          step.view = freshStep(id, type, max_iterations, step.depends_on).view;
        }
        spend = addSpend(ZERO_SPEND, payload['budget_spent']);
        const done = payload['steps_done'] !== null && typeof payload['steps_done'] === 'object' ? payload['steps_done'] as Payload : {};
        for (const [id, summary] of Object.entries(done)) {
          const view = steps.get(id)?.view;
          if (view === undefined) throw new RunStateError(`Epoch summary names unknown step ${JSON.stringify(id)}.`);
          enter(view, 'done');
          // `StepDoneSummary` (kernel entry.rs) carries `completionReason` and
          // nothing else about the attempt. Keep the reason, which dependency
          // readiness and the glyph need; invent no attempt record around it.
          const facts = summary !== null && typeof summary === 'object' ? summary as Payload : {};
          view.completion_reason = text(facts['completionReason'], 'unknown');
        }
        const open = payload['steps_open'] !== null && typeof payload['steps_open'] === 'object' ? payload['steps_open'] as Payload : {};
        for (const [id, summary] of Object.entries(open)) {
          const view = steps.get(id)?.view;
          if (view === undefined) throw new RunStateError(`Epoch summary names unknown step ${JSON.stringify(id)}.`);
          const facts = summary !== null && typeof summary === 'object' ? summary as Payload : {};
          view.attempt = integer(facts['attempt']) ?? 0;
          const state = facts['state'];
          if (state === 'running') {
            enter(view, 'running');
            // The summary carries no original attempt start, and the kernel
            // does not track one. Stamping the epoch's own time here made the
            // live `attempt-<n>.*.tail` header look stale to
            // `readTranscriptTail` and restarted elapsed at the compaction.
            // Unknown is the honest value: elapsed goes unrendered and the
            // tail's staleness check is skipped rather than failed.
            view.started_at_ms = null;
            view.lease = { deadline_ms: integer(facts['lease_deadline_ms']) ?? event.at_ms, overdue_ms: 0 };
          } else if (state === 'backoff') {
            enter(view, 'backoff');
            view.backoff_until_ms = integer(facts['wake_at_ms']) ?? event.at_ms;
          } else if (state === 'needs_human') {
            enter(view, 'needs_human');
            view.wait = { wait_id: `epoch-${integer(payload['epoch']) ?? 0}-${id}`, kind: 'human', timeout_at_ms: null };
          } else if (state === 'waiting') {
            enter(view, 'waiting');
            view.wait = { wait_id: text(facts['wait_id']), kind: 'event', timeout_at_ms: null };
          }
        }
        break;
      }
      case 'run.completed':
        completion = text(payload['completionReason'], 'unknown');
        spend = addSpend(ZERO_SPEND, payload['budget_total']);
        break;
      case 'run.cancel.requested':
        cancelRequested = true;
        break;
      default:
        // Routing, subscriptions, channels, streams, effects, memory and
        // segment records change nothing a status view shows.
        break;
    }
  }

  // state.rs `refresh_runnable`: a pending step whose dependencies all
  // succeeded is runnable, whether or not a worker has picked it up.
  for (const step of steps.values()) {
    if (step.view.state !== 'pending') continue;
    const ready = step.depends_on.every((dependency) => {
      const upstream = steps.get(dependency)?.view;
      return upstream?.state === 'done' && upstream.completion_reason === 'success';
    });
    if (ready) step.view.state = 'runnable';
  }

  const views: StepView[] = [];
  const counts: StepCounts = { total: 0, done: 0, running: 0, pending: 0, backoff: 0, waiting: 0, needs_human: 0 };
  for (const { view } of steps.values()) {
    if (view.started_at_ms !== null) {
      // `ended_at_ms` belongs to the attempt that ended. A retry, wait or
      // sleep starts a newer attempt whose `started_at_ms` is later than that,
      // and measuring to the older end clamped a live wait's elapsed to zero.
      const ended = view.last_attempt?.ended_at_ms ?? null;
      const end = ended === null || ended < view.started_at_ms ? now_ms : ended;
      view.elapsed_ms = Math.max(0, (view.state === 'running' ? now_ms : end) - view.started_at_ms);
    }
    if (view.lease !== null) view.lease.overdue_ms = Math.max(0, now_ms - view.lease.deadline_ms);
    counts.total += 1;
    if (view.state === 'pending' || view.state === 'runnable') counts.pending += 1;
    else counts[view.state] += 1;
    views.push(view);
  }

  const status: RunStatus = completion === null
    ? cancelRequested ? 'cancelling' : counts.needs_human > 0 ? 'parked' : 'running'
    : completion === 'success' ? 'completed' : completion === 'canceled' ? 'cancelled' : 'failed';

  return {
    run_id: first.run_id,
    name: text(spec['name'], first.run_id),
    status,
    completion_reason: completion,
    spawned_at_ms: first.at_ms,
    now_ms,
    spend,
    counts,
    steps: views,
  };
}
