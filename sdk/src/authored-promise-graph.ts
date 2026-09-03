import { createHook, executionAsyncId, type AsyncHook } from 'node:async_hooks';

/**
 * The promise graph an authored flow body actually creates.
 *
 * Three properties matter and each one is a repair of a measured defect:
 *
 * 1. **Scoped.** Only promises created while the owning lifecycle is the active
 *    `AsyncLocalStorage` store are recorded. A previous revision recorded every
 *    promise created anywhere in the process for the life of the flow; a probe
 *    measured 20 002 unrelated promises retained.
 * 2. **Eagerly attributed.** A promise is attributed to a root the moment it is
 *    created, or the moment its parent becomes attributed — never by walking the
 *    graph per candidate at completion time. The walk made the completion gate
 *    quadratic: a 27 ms body with 30 000 ordinary awaits spent 95.8 s in the gate.
 * 3. **Complete, not sampled.** `pending` is the set of tracked promises that have
 *    not settled. Derived work in flight is a fact the gate can read, so the gate
 *    never has to guess whether a failure "has landed yet".
 *
 * Attribution flows forward along the same `trigger` edge the previous revision
 * walked backward, so it admits exactly the same set — it just knows the answer
 * before it is asked. Children created before their parent becomes a root are
 * parked in `unattributedChildren` and flooded when the root is registered; a
 * promise cannot settle before its ancestors, and a root is always registered
 * before it settles, so no parked child is ever missed.
 */
export class AuthoredPromiseGraph {
  private readonly hook: AsyncHook;
  private readonly triggers = new Map<number, number>();
  private readonly creationContexts = new Map<number, number>();
  private readonly resolutionCauses = new Map<number, number>();
  private readonly promiseIds = new WeakMap<object, number>();
  private readonly handles = new Map<number, Promise<unknown>>();
  private readonly unattributedChildren = new Map<number, number[]>();
  private readonly attributedRoots = new Map<number, number>();
  private readonly roots = new Set<number>();
  private readonly pending = new Set<number>();
  private dependencyCache: { readonly start: number; readonly found: ReadonlySet<number> } | undefined;

  constructor(
    private readonly inScope: () => boolean,
    private readonly onPromiseResolve: (asyncId: number) => void,
  ) {
    this.hook = createHook({
      init: (asyncId, type, triggerAsyncId, resource) => {
        if (type !== 'PROMISE' || typeof resource !== 'object' || resource === null) return;
        if (!this.inScope()) return;
        this.triggers.set(asyncId, triggerAsyncId);
        this.creationContexts.set(asyncId, executionAsyncId());
        this.promiseIds.set(resource, asyncId);
        this.handles.set(asyncId, resource as Promise<unknown>);
        this.pending.add(asyncId);
        const root = this.roots.has(triggerAsyncId)
          ? triggerAsyncId
          : this.attributedRoots.get(triggerAsyncId);
        if (root !== undefined) this.attribute(asyncId, root);
        else if (this.triggers.has(triggerAsyncId)) this.park(triggerAsyncId, asyncId);
      },
      promiseResolve: (asyncId) => {
        this.onPromiseResolve(asyncId);
        if (!this.triggers.has(asyncId)) return;
        const cause = executionAsyncId();
        if (cause !== asyncId) this.resolutionCauses.set(asyncId, cause);
        this.pending.delete(asyncId);
        if (this.attributedRoots.has(asyncId) || this.roots.has(asyncId)) return;
        // A combinator's aggregate is resolved from inside the reaction of one of
        // its members, so it is not downstream of any member by `trigger` and can
        // only inherit attribution here, from the context that resolved it. Without
        // this, only `Promise.all` was covered — because it is the one combinator
        // registered explicitly — and `Promise.allSettled`, `Promise.any` and
        // `Promise.race` each carried a deferred derived failure to terminal
        // success. Measured; see ops/probes/pr134-repair-0903/combinators.mjs.
        const adopted = this.attributedRoots.get(cause);
        if (adopted !== undefined) {
          this.attribute(asyncId, adopted);
          return;
        }
        // A settled, unattributed promise can never become attributed: attribution
        // only reaches a promise while its root is still pending. Release it.
        this.handles.delete(asyncId);
        this.unattributedChildren.delete(asyncId);
      },
    });
  }

  enable(): void {
    this.hook.enable();
  }

  disable(): void {
    this.hook.disable();
  }

  idOf(value: object): number | undefined {
    return this.promiseIds.get(value);
  }

  /** Mark a promise whose descendants belong to an authored operation. */
  registerRoot(asyncId: number): void {
    if (asyncId <= 0 || this.roots.has(asyncId)) return;
    this.roots.add(asyncId);
    const parked = this.unattributedChildren.get(asyncId);
    if (parked === undefined) return;
    this.unattributedChildren.delete(asyncId);
    for (const child of parked) this.attribute(child, asyncId);
  }

  /** Promises derived from `roots` that have not settled. */
  inFlightFrom(roots: ReadonlySet<number>): number[] {
    const found: number[] = [];
    for (const asyncId of this.pending) {
      const root = this.attributedRoots.get(asyncId);
      if (root !== undefined && roots.has(root)) found.push(asyncId);
    }
    return found;
  }

  /** Settled promises derived from `roots`, with their handles. */
  settledFrom(roots: ReadonlySet<number>): Promise<unknown>[] {
    const found: Promise<unknown>[] = [];
    for (const [asyncId, root] of this.attributedRoots) {
      if (!roots.has(root) || this.pending.has(asyncId)) continue;
      const handle = this.handles.get(asyncId);
      if (handle !== undefined) found.push(handle);
    }
    return found;
  }

  dependsOn(descendant: number, ancestor: number): boolean {
    return this.dependenciesOf(descendant).has(ancestor);
  }

  clear(): void {
    this.triggers.clear();
    this.creationContexts.clear();
    this.resolutionCauses.clear();
    this.handles.clear();
    this.unattributedChildren.clear();
    this.attributedRoots.clear();
    this.roots.clear();
    this.pending.clear();
    this.dependencyCache = undefined;
  }

  private attribute(start: number, root: number): void {
    const stack = [start];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (this.attributedRoots.has(current) || this.roots.has(current)) continue;
      this.attributedRoots.set(current, root);
      const parked = this.unattributedChildren.get(current);
      if (parked === undefined) continue;
      this.unattributedChildren.delete(current);
      for (const child of parked) stack.push(child);
    }
  }

  private park(parent: number, child: number): void {
    const parked = this.unattributedChildren.get(parent);
    if (parked === undefined) this.unattributedChildren.set(parent, [child]);
    else parked.push(child);
  }

  /**
   * Everything the promise identified by `start` could have waited for.
   *
   * Three edges, and the third is the repair. `trigger` and `resolutionCause`
   * alone do not connect an async function's resumption context to the context
   * it was suspended from, so a walk from `done()` reached only the *last*
   * await's lineage: `const steps = [f.run(a), f.run(b)]; for (const s of steps)
   * await s;` reported run-1 unawaited even though every step was awaited. The
   * init-time `executionAsyncId()` — the context a promise was created in — is
   * that missing edge, and it is a fact the runtime reports, not a widened
   * approximation.
   */
  private dependenciesOf(start: number): ReadonlySet<number> {
    const cached = this.dependencyCache;
    if (cached !== undefined && cached.start === start) return cached.found;
    const found = new Set<number>();
    const stack = [start];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (found.has(current)) continue;
      found.add(current);
      for (const edge of [
        this.triggers.get(current),
        this.resolutionCauses.get(current),
        this.creationContexts.get(current),
      ]) {
        if (edge !== undefined && edge !== current) stack.push(edge);
      }
    }
    this.dependencyCache = { start, found };
    return found;
  }
}
