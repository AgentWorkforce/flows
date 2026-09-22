import { inspect } from 'node:util';
import { MAX_AFTER, displayLabel, type AuthoredStepEdges } from './authored-step-index.js';

/**
 * The named DAG an authored body draws, recorded as it runs.
 *
 * An authored flow is plain TypeScript, so the shape Cloud wants to draw — which
 * `f.agent` waited for which — is not declared anywhere. It is, however, a fact
 * the runtime already holds: the promise graph (`authored-promise-graph.ts`)
 * records, for every promise the body creates, what triggered it, what resolved
 * it, and which context created it. A step's causal predecessors are the step
 * promises reachable backward from the context that invoked it.
 *
 * Three rules make that walk an answer rather than an approximation:
 *
 * 1. **Stop at steps.** A step promise is a frontier; what it waited for is its
 *    own `after`, not ours.
 * 2. **Expand an aggregate that waited for every member.** The runtime links a
 *    combinator's aggregate only to the member whose settlement settled it.
 *    That member is the whole answer when the aggregate settled on the first
 *    member that could decide it — a rejected `all`, a fulfilled `any`, any
 *    `race` — and a fraction of it when the aggregate had to wait for all of
 *    them: a fulfilled `all`, a rejected `any`, every `allSettled`. Which case
 *    applies is known only once the aggregate settles, so it is decided when a
 *    walk reaches the aggregate (`registerAggregate`, `promiseOutcome`).
 * 3. **Reduce transitively.** `a → b → c` reaches both `a` and `b` from `c`;
 *    `a` is an ancestor of `b`, so it is dropped.
 *
 * Cost is bounded, not quadratic. Each invocation context's frontier is
 * memoized, and a walk that reaches an already-answered context takes its
 * answer instead of re-walking the history behind it — so a long sequential
 * body walks a few nodes per step. A walk that still exceeds `walkLimit` stops
 * and says so (`afterTruncated`) rather than guessing silently.
 *
 * This is observational metadata: it never gates execution, and it changes no
 * step id, admission key or resume identity.
 */
export const MAX_WALK = 10_000;

interface Frontier {
  readonly steps: readonly string[];
  readonly truncated: boolean;
}

interface StepNode {
  readonly order: number;
  readonly after: readonly string[];
  /** `after` may be incomplete, so a reduction that relies on it may keep an ancestor. */
  readonly truncated: boolean;
}

type Combinator = 'all' | 'allSettled' | 'any' | 'race';
type Outcome = 'pending' | 'fulfilled' | 'rejected';

/** The settlement on which a combinator had waited for every member. */
const EXPANDS_ON: Readonly<Record<Combinator, Outcome | 'always' | undefined>> = {
  all: 'fulfilled',
  allSettled: 'always',
  any: 'rejected',
  race: undefined,
};

interface Aggregate {
  readonly promise: Promise<unknown>;
  /** Cached once settled: a settled promise never changes state. */
  outcome?: Outcome;
  readonly expandsOn: Outcome | 'always';
  readonly members: readonly number[];
}

export class AuthoredStepGraph {
  private readonly stepPromises = new Map<number, string>();
  private readonly aggregates = new Map<number, Aggregate>();
  private readonly contexts = new Map<number, Frontier>();
  private readonly nodes = new Map<string, StepNode>();
  private readonly edges = new Map<string, AuthoredStepEdges>();

  constructor(
    private readonly causesOf: (asyncId: number) => readonly number[],
    private readonly walkLimit = MAX_WALK,
  ) {}

  /** A combinator's aggregate and its members, for expansion once it settles. */
  registerAggregate(
    aggregateId: number,
    promise: Promise<unknown>,
    combinator: Combinator,
    members: readonly number[],
  ): void {
    const expandsOn = EXPANDS_ON[combinator];
    if (expandsOn === undefined || members.length === 0) return;
    this.aggregates.set(aggregateId, { promise, expandsOn, members });
  }

  /**
   * Record a step invoked from `contextId`. `promiseId` is the step's own
   * promise, when the promise graph saw it, so later walks stop there.
   */
  registerStep(
    step: string,
    promiseId: number | undefined,
    contextId: number,
    label?: string,
  ): AuthoredStepEdges {
    const frontier = this.frontierOf(contextId);
    this.nodes.set(step, { order: this.nodes.size, after: frontier.steps, truncated: frontier.truncated });
    if (promiseId !== undefined) this.stepPromises.set(promiseId, step);
    const truncated = frontier.truncated || frontier.steps.length > MAX_AFTER;
    const edges: AuthoredStepEdges = Object.freeze({
      ...displayLabel(label),
      ...(frontier.steps.length === 0 ? {} : { after: Object.freeze(frontier.steps.slice(0, MAX_AFTER)) }),
      ...(truncated ? { afterTruncated: true as const } : {}),
    });
    this.edges.set(step, edges);
    return edges;
  }

  edgesOf(step: string): AuthoredStepEdges | undefined {
    return this.edges.get(step);
  }

  /** Drop the walk state; recorded edges stay readable for late record writes. */
  release(): void {
    this.stepPromises.clear();
    this.aggregates.clear();
    this.contexts.clear();
    this.nodes.clear();
  }

  private frontierOf(start: number): Frontier {
    const memo = this.contexts.get(start);
    if (memo !== undefined) return memo;
    const candidates = new Set<string>();
    let truncated = false;
    const visited = new Set<number>([start]);
    const queue = [start];
    // Breadth-first, so that a walk cut short by the limit has already found
    // the nearest predecessors and lost only distant history.
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head]!;
      const step = this.stepPromises.get(current);
      if (step !== undefined) {
        candidates.add(step);
        continue;
      }
      const answered = current === start ? undefined : this.contexts.get(current);
      if (answered !== undefined) {
        for (const found of answered.steps) candidates.add(found);
        truncated ||= answered.truncated;
        continue;
      }
      for (const id of [...this.waitedFor(current), ...this.causesOf(current)]) {
        if (visited.has(id)) continue;
        // At the limit, stop growing the walk but still drain what is queued:
        // those nodes are already known and cost one lookup each.
        if (visited.size >= this.walkLimit) {
          truncated = true;
          break;
        }
        visited.add(id);
        queue.push(id);
      }
    }
    const reduced = this.reduce(candidates);
    const frontier = Object.freeze({ steps: reduced.steps, truncated: truncated || reduced.truncated });
    this.contexts.set(start, frontier);
    return frontier;
  }

  /** The members an aggregate waited for beyond its own resolution edge. */
  private waitedFor(asyncId: number): readonly number[] {
    const aggregate = this.aggregates.get(asyncId);
    if (aggregate === undefined) return [];
    if (aggregate.expandsOn === 'always') return aggregate.members;
    if (aggregate.outcome === undefined) {
      const outcome = promiseOutcome(aggregate.promise);
      if (outcome !== 'pending') aggregate.outcome = outcome;
    }
    return aggregate.outcome === aggregate.expandsOn ? aggregate.members : [];
  }

  /**
   * Drop every candidate that is an ancestor of another candidate. The
   * reduction reads recorded `after` lists; when one it reads is incomplete,
   * a redundant ancestor can survive, and the result says so.
   */
  private reduce(candidates: ReadonlySet<string>): Frontier {
    const ordered = [...candidates].sort((a, b) => this.orderOf(a) - this.orderOf(b));
    if (ordered.length <= 1) return { steps: ordered, truncated: false };
    // An ancestor is always registered before its descendant, so nothing
    // older than the oldest candidate can be one: the walk stops there.
    const oldest = this.orderOf(ordered[0]!);
    const reached = new Set<string>();
    // Predecessor lists are read through cursors, never copied onto the stack, and every entry
    // inspected counts toward the limit — duplicates included — so a wide fan-in bounds both
    // allocation and work, not just the number of distinct steps reached.
    const stack: Array<{ readonly values: readonly string[]; next: number }> = [];
    const pushList = (values: readonly string[] | undefined): void => {
      if (values !== undefined && values.length > 0) stack.push({ values, next: 0 });
    };
    for (const step of ordered) pushList(this.nodes.get(step)?.after);
    let inspected = 0;
    let truncated = ordered.some((step) => this.nodes.get(step)?.truncated === true);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const step = frame.values[frame.next++]!;
      if (frame.next === frame.values.length) stack.pop();
      if (++inspected > this.walkLimit) {
        truncated = true;
        break;
      }
      if (reached.has(step)) continue;
      reached.add(step);
      const node = this.nodes.get(step);
      if (node === undefined || node.order <= oldest) continue;
      truncated ||= node.truncated;
      pushList(node.after);
    }
    return { steps: ordered.filter((step) => !reached.has(step)), truncated };
  }

  private orderOf(step: string): number {
    return this.nodes.get(step)?.order ?? -1;
  }
}

/**
 * Whether a promise has settled, and how, read without attaching a handler.
 *
 * Attaching one would mark an author's rejected aggregate as handled and hide
 * an unhandled rejection the process would otherwise report, so the state is
 * read the one public way that has no such effect: Node's own inspection.
 * `customInspect`, `getters` and `showProxy` keep author code and proxy traps
 * from running; `depth: 0` and the length caps keep the rendered value small.
 * Every option the match depends on is set here, because `inspect` fills the
 * rest from `util.inspect.defaultOptions`, which any code in the process can
 * change — `colors: true` there would wrap `<rejected>` in ANSI escapes.
 */
export function promiseOutcome(promise: Promise<unknown>): Outcome {
  const shown = inspect(promise, {
    depth: 0, customInspect: false, getters: false, showProxy: true, colors: false,
    compact: 3, sorted: false, maxArrayLength: 0, maxStringLength: 0, breakLength: Infinity,
  });
  const state = /^[^{]*\{\s*<(pending|rejected)>/u.exec(shown)?.[1];
  return state === 'pending' ? 'pending' : state === 'rejected' ? 'rejected' : 'fulfilled';
}
