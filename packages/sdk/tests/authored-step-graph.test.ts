import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Step } from '@relayflows/surface';
import {
  AuthoredFlowOperation,
  verifyAuthoredOperations,
} from '../src/authored-flow-operation.js';
import { AuthoredFlowLifecycle } from '../src/authored-flow-lifecycle.js';
import { AuthoredStepGraph, promiseOutcome } from '../src/authored-step-graph.js';

type Op = (label: string, delayMs?: number, fails?: boolean, polls?: number) => Step<string>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a body against a real lifecycle, the way the executor does, and return
 * each step's predecessors by LABEL so the assertions read as the DAG drawn.
 */
async function graphOf(body: (op: Op) => Promise<void>, { stepsFail = false } = {}): Promise<Record<string, {
  after: string[];
  truncated: boolean;
}>> {
  const lifecycle = new AuthoredFlowLifecycle();
  const operations: AuthoredFlowOperation<unknown>[] = [];
  const op: Op = (label, delayMs = 0, fails = false, polls = 0) => {
    const operation = new AuthoredFlowOperation<string>(
      `agent-${operations.length + 1}`, 'agent', () => undefined,
      async () => {
        // A long-running step's own promise chain, as `classifyOutcome`'s
        // journal polling builds one: every poll is a fresh await, and every
        // few a timer, all inside the lifecycle's scope.
        for (let poll = 0; poll < polls; poll++) {
          if (poll % 1_000 === 0) await sleep(0);
          else await Promise.resolve(poll);
        }
        if (delayMs > 0) await sleep(delayMs);
        if (fails) throw new Error(`${label} failed`);
        return label;
      },
      lifecycle,
      { label },
    );
    operations.push(operation as AuthoredFlowOperation<unknown>);
    return operation.step;
  };
  try {
    await lifecycle.runBody(async () => {
      await body(op);
      lifecycle.markCompletion();
    });
    // A failed step fails the flow even when the body caught it; the edges it
    // drew were recorded at invocation and are what is asserted here.
    const verified = verifyAuthoredOperations('step-graph', operations, lifecycle);
    if (stepsFail) await expect(verified).rejects.toThrow(/failed/u);
    else await verified;
  } finally {
    lifecycle.close();
  }
  const labels = new Map(operations.map((operation) => [operation.id, operation.edges?.label ?? '?']));
  return Object.fromEntries(operations.map((operation) => {
    const edges = lifecycle.stepEdges(operation.id);
    // The id is the kernel identity and is minted exactly as before.
    expect(operation.edges).toBe(edges);
    return [edges?.label ?? operation.id, {
      // `after` is in step-creation order, which timing decides; compare as a set.
      after: (edges?.after ?? []).map((step) => labels.get(step) ?? step).sort(),
      truncated: edges?.afterTruncated === true,
    }];
  }));
}

const after = (...labels: string[]) => ({ after: labels.sort(), truncated: false });

describe('the authored step DAG', () => {
  it('draws no edge between siblings of a parallel fan-out', async () => {
    const graph = await graphOf(async (op) => {
      const a = op('a', 15);
      const b = op('b', 5);
      const c = op('c');
      await Promise.all([a, b, c]);
    });
    expect(graph).toEqual({ a: after(), b: after(), c: after() });
  });

  it('draws a sequential chain as a chain, not as a fan-in from every earlier step', async () => {
    const graph = await graphOf(async (op) => {
      await op('a');
      await op('b');
      await op('c');
    });
    expect(graph).toEqual({ a: after(), b: after('a'), c: after('b') });
  });

  it('makes a step after `await Promise.all(deps)` depend on every dep, whatever settled last', async () => {
    const graph = await graphOf(async (op) => {
      const deps = [op('slow', 20), op('fast'), op('middle', 5)];
      await Promise.all(deps);
      await op('join');
    });
    expect(graph['join']).toEqual(after('slow', 'fast', 'middle'));
  });

  it('expands Promise.allSettled the same way', async () => {
    const graph = await graphOf(async (op) => {
      await Promise.allSettled([op('x', 10), op('y')]);
      await op('z');
    });
    expect(graph['z']).toEqual(after('x', 'y'));
  });

  it('follows only the winner of a race', async () => {
    const graph = await graphOf(async (op) => {
      const slow = op('slow', 30);
      await Promise.race([op('fast'), slow]);
      await op('next');
      await slow;
    });
    expect(graph['next']).toEqual(after('fast'));
  });

  it('makes a step after a caught Promise.all rejection depend on the rejecting member only', async () => {
    // `all` rejects on the first rejection; the slow member was still running
    // when the recovery step started, so it is not a predecessor.
    const graph = await graphOf(async (op) => {
      const slow = op('slow', 30);
      try {
        await Promise.all([op('boom', 0, true), slow]);
      } catch { /* the author recovers */ }
      await op('recover');
      await slow;
    }, { stepsFail: true });
    expect(graph['recover']).toEqual(after('boom'));
  });

  it('makes a step after a fulfilled Promise.any depend on the winner only', async () => {
    const graph = await graphOf(async (op) => {
      const slow = op('slow', 30);
      await Promise.any([op('fast'), slow]);
      await op('next');
      await slow;
    });
    expect(graph['next']).toEqual(after('fast'));
  });

  it('makes a step after a caught Promise.any rejection depend on every member', async () => {
    // `any` rejects only once every member has rejected, whichever was last.
    const graph = await graphOf(async (op) => {
      try {
        await Promise.any([op('first', 15, true), op('second', 0, true)]);
      } catch { /* AggregateError: the author recovers */ }
      await op('recover');
    }, { stepsFail: true });
    expect(graph['recover']).toEqual(after('first', 'second'));
  });

  it('expands Promise.allSettled whatever its members did', async () => {
    const graph = await graphOf(async (op) => {
      await Promise.allSettled([op('ok', 10), op('bad', 0, true)]);
      await op('next');
    }, { stepsFail: true });
    expect(graph['next']).toEqual(after('ok', 'bad'));
  });

  it('reduces a diamond to its direct predecessors', async () => {
    const graph = await graphOf(async (op) => {
      await op('root');
      const left = op('left', 10);
      const right = op('right');
      await Promise.all([left, right]);
      await op('sink');
    });
    expect(graph).toEqual({
      root: after(), left: after('root'), right: after('root'), sink: after('left', 'right'),
    });
  });

  it('sees through async wrapper functions', async () => {
    const graph = await graphOf(async (op) => {
      const first = (async () => {
        await op('a1', 10);
        await op('a2');
      })();
      const second = (async () => {
        await op('b1');
      })();
      await Promise.all([first, second]);
      await op('after-both');
    });
    expect(graph).toEqual({
      a1: after(), a2: after('a1'), b1: after(), 'after-both': after('a2', 'b1'),
    });
  });

  it('draws the task-graph pattern: a map of promises, each awaiting its deps', async () => {
    // The examples/task-graph shape: every subtask is started at once, awaits
    // the promises of the subtasks it depends on, then runs a chain.
    const plan = [
      { id: 'schema', deps: [] as string[], delayMs: 10 },
      { id: 'api', deps: ['schema'], delayMs: 0 },
      { id: 'ui', deps: ['schema'], delayMs: 5 },
      { id: 'docs', deps: [], delayMs: 0 },
      { id: 'e2e', deps: ['api', 'ui', 'docs'], delayMs: 0 },
    ];
    const graph = await graphOf(async (op) => {
      const done = new Map<string, Promise<void>>();
      for (const task of plan) {
        done.set(task.id, (async () => {
          await Promise.all(task.deps.map((dep) => done.get(dep)));
          await op(`${task.id}:setup`, task.delayMs);
          await op(`${task.id}:agent`);
          await op(`${task.id}:verify`);
        })());
      }
      await Promise.all(done.values());
    });
    expect(graph).toEqual({
      'schema:setup': after(), 'schema:agent': after('schema:setup'), 'schema:verify': after('schema:agent'),
      'api:setup': after('schema:verify'), 'api:agent': after('api:setup'), 'api:verify': after('api:agent'),
      'ui:setup': after('schema:verify'), 'ui:agent': after('ui:setup'), 'ui:verify': after('ui:agent'),
      'docs:setup': after(), 'docs:agent': after('docs:setup'), 'docs:verify': after('docs:agent'),
      'e2e:setup': after('api:verify', 'ui:verify', 'docs:verify'),
      'e2e:agent': after('e2e:setup'), 'e2e:verify': after('e2e:agent'),
    });
  });

  it('does not walk a long-running step\'s own polling chain to find its dependents\' edges', async () => {
    // 30 000 polls is three times the walk limit. If a walk entered the
    // step's internal chain instead of stopping at the step, `next` would
    // come back truncated or with a wrong predecessor.
    const graph = await graphOf(async (op) => {
      const long = op('long', 0, false, 30_000);
      await op('quick');
      await op('after-quick');
      await long;
      await op('join');
      await op('next');
    });
    expect(graph).toEqual({
      long: after(), quick: after(), 'after-quick': after('quick'),
      join: after('after-quick', 'long'), next: after('join'),
    });
  }, 30_000);

  it('does not walk a long-running step\'s chain when a wrapper awaits it', async () => {
    const graph = await graphOf(async (op) => {
      const branch = (async () => {
        await op('long', 0, false, 30_000);
        await op('after-long');
      })();
      await op('side');
      await branch;
      await op('join');
    });
    expect(graph).toEqual({
      long: after(), 'after-long': after('long'), side: after(), join: after('after-long', 'side'),
    });
  }, 30_000);

  it('caps a wide fan-in at 32 predecessors and says it did', async () => {
    const graph = await graphOf(async (op) => {
      await Promise.all(Array.from({ length: 40 }, (_, i) => op(`w${i}`)));
      await op('join');
    });
    expect(graph['join']!.after).toHaveLength(32);
    expect(graph['join']!.truncated).toBe(true);
  });

  it('keeps a long sequential body linear: 300 steps, each after exactly its predecessor', async () => {
    const graph = await graphOf(async (op) => {
      for (let i = 0; i < 300; i++) {
        await op(`s${i}`);
        // Ordinary awaits between steps grow the promise graph, not the edges.
        for (let j = 0; j < 20; j++) await null;
      }
    });
    expect(graph['s0']).toEqual(after());
    for (let i = 1; i < 300; i++) expect(graph[`s${i}`]).toEqual(after(`s${i - 1}`));
  });
});

describe('the walk limit', () => {
  it('stops at the node cap and marks the result truncated instead of walking on', () => {
    // A synthetic chain of 50 000 promises between the step and its caller:
    // with a cap of 1 000 the walk must give up, visit no more than the cap,
    // and say the answer is incomplete.
    let visits = 0;
    const graph = new AuthoredStepGraph((asyncId) => {
      visits += 1;
      return asyncId > 1 ? [asyncId - 1] : [];
    }, 1_000);
    graph.registerStep('agent-1', 1, 0);
    visits = 0;
    const edges = graph.registerStep('agent-2', 50_001, 50_000, 'far');
    expect(edges).toEqual({ label: 'far', afterTruncated: true });
    expect(visits).toBeLessThanOrEqual(1_000);
  });

  it('finds the predecessor when it is within the cap', () => {
    const graph = new AuthoredStepGraph((asyncId) => (asyncId > 1 ? [asyncId - 1] : []), 1_000);
    graph.registerStep('agent-1', 1, 0);
    expect(graph.registerStep('agent-2', 600, 500)).toEqual({ after: ['agent-1'] });
  });
});

describe('truncation through the reduction', () => {
  // A chain of promise ids ending in a step promise: 1 is `s1`'s promise, and
  // the walk from 2_000 must pass 1_000 ids to reach it.
  const chain = (asyncId: number): number[] => {
    if (asyncId === 5_000) return [1, 3_000];
    return asyncId > 1_000 && asyncId <= 2_000 ? [asyncId - 1] : [];
  };

  it('marks a join truncated when a predecessor it reduces against has an incomplete list', () => {
    const graph = new AuthoredStepGraph(chain, 100);
    graph.registerStep('s1', 1, 0);
    // `s2` is invoked 1 000 ids after `s1`: its walk gives up and it cannot
    // say whether `s1` is its ancestor.
    expect(graph.registerStep('s2', 3_000, 2_000)).toEqual({ afterTruncated: true });
    // A join of both may therefore keep `s1` when it is really an ancestor of
    // `s2`, and must say that its list is not known to be reduced.
    expect(graph.registerStep('s3', 6_000, 5_000)).toEqual({ after: ['s1', 's2'], afterTruncated: true });
  });

  it('does not mark a join whose predecessors all have complete lists', () => {
    const graph = new AuthoredStepGraph(chain, 10_000);
    graph.registerStep('s1', 1, 0);
    expect(graph.registerStep('s2', 3_000, 2_000)).toEqual({});
    expect(graph.registerStep('s3', 6_000, 5_000)).toEqual({ after: ['s1', 's2'] });
  });
});

describe('a wide fan-in', () => {
  it('counts every predecessor entry it inspects against the limit, not just distinct steps', () => {
    // 200 independent steps, 20 siblings that each wait for all of them, then
    // a join of the siblings. Reducing the join reads 4 000 predecessor
    // entries but reaches only 200 distinct steps — under a 1 000 limit that
    // counted distinct steps alone, it would never stop.
    const bases = Array.from({ length: 200 }, (_, i) => 1 + i);
    const siblings = Array.from({ length: 20 }, (_, i) => 1_001 + i);
    const causes = new Map<number, readonly number[]>();
    siblings.forEach((_, i) => causes.set(2_001 + i, bases));
    causes.set(5_000, siblings);
    const graph = new AuthoredStepGraph((asyncId) => causes.get(asyncId) ?? [], 1_000);
    bases.forEach((promise, i) => graph.registerStep(`b${i}`, promise, 0));
    siblings.forEach((promise, i) => graph.registerStep(`s${i}`, promise, 2_001 + i));
    expect(graph.registerStep('join', 6_000, 5_000)).toEqual({
      after: siblings.map((_, i) => `s${i}`),
      afterTruncated: true,
    });
  });
});

describe('reading a settlement without handling it', () => {
  it('reports pending, fulfilled and rejected, including for a Promise subclass', async () => {
    class Sub<T> extends Promise<T> {}
    const rejected = Promise.reject(new Error('no'));
    rejected.catch(() => undefined);
    const subRejected = Sub.reject(1);
    subRejected.catch(() => undefined);
    await sleep(0);
    expect(promiseOutcome(new Promise(() => undefined))).toBe('pending');
    expect(promiseOutcome(Promise.resolve({ value: 1 }))).toBe('fulfilled');
    expect(promiseOutcome(Promise.resolve('<rejected> in the value'))).toBe('fulfilled');
    expect(promiseOutcome(rejected)).toBe('rejected');
    expect(promiseOutcome(subRejected)).toBe('rejected');
  });

  it('ignores process-wide inspect defaults such as colors', async () => {
    const rejected = Promise.reject(new Error('no'));
    rejected.catch(() => undefined);
    await sleep(0);
    const defaults = { ...inspect.defaultOptions };
    Object.assign(inspect.defaultOptions, { colors: true, compact: false, sorted: true });
    try {
      expect(promiseOutcome(rejected)).toBe('rejected');
      expect(promiseOutcome(new Promise(() => undefined))).toBe('pending');
    } finally {
      Object.assign(inspect.defaultOptions, defaults);
    }
  });

  it('runs no author inspection hook or proxy trap on the settled value', () => {
    let ran = 0;
    const value = new Proxy({ [Symbol.for('nodejs.util.inspect.custom')]: () => { ran += 1; return 'x'; } }, {
      get(target, key) { ran += 1; return Reflect.get(target, key); },
      ownKeys(target) { ran += 1; return Reflect.ownKeys(target); },
    });
    // Resolve with a non-thenable holder: resolving with the proxy itself
    // would read its `then`, which is the runtime's doing, not the probe's.
    const settled = Promise.resolve([value]);
    return settled.then(() => {
      ran = 0;
      expect(promiseOutcome(settled)).toBe('fulfilled');
      expect(ran).toBe(0);
    });
  });
});

describe('step labels', () => {
  it('keeps a label whole or omits it, never cuts it', () => {
    // A cut label could end mid-secret, where Cloud's whole-value redactor
    // cannot match it. Over the bound, there is no label at all.
    const graph = new AuthoredStepGraph(() => []);
    expect(graph.registerStep('agent-1', 1, 0, 'writer')).toEqual({ label: 'writer' });
    expect(graph.registerStep('agent-2', 2, 0, 'w'.repeat(256))).toEqual({ label: 'w'.repeat(256) });
    expect(graph.registerStep('agent-3', 3, 0, 'w'.repeat(257))).toEqual({});
    expect(graph.registerStep('agent-4', 4, 0, '   ')).toEqual({});
  });
});
