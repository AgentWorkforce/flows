/**
 * Which of a fixed set of `targets` each of `starts` can reach by following
 * `edgesOf` — the batch form of asking `dependsOn(start, target)` for every
 * pair, with the same answer (a node reaches itself).
 *
 * The completion gate used to ask that pair-by-pair, re-walking each start's
 * whole ancestry every time: operations × combinator members × tracked
 * promises. A flow of ~110 steps whose agents ran for twenty minutes produced
 * enough tracked promises (journal polling while each step waited) that the
 * gate ran for three minutes without yielding, starving the root's lease
 * renewal until the run was reaped as crashed.
 *
 * Here the upward closure of every start is visited once, cycles (a promise
 * resolved from a context created after it) are condensed with an iterative
 * Tarjan pass, and target sets flow as bitsets from ancestors to descendants
 * in the order Tarjan emits components. Cost is O((V + E) · ⌈T / 32⌉) for the
 * visited subgraph, whatever the number of starts.
 */
export function reachableTargets(
  starts: readonly number[],
  targets: readonly number[],
  edgesOf: (node: number) => readonly number[],
): Map<number, ReadonlySet<number>> {
  const bit = new Map<number, number>();
  for (const target of targets) if (!bit.has(target)) bit.set(target, bit.size);
  const words = Math.max(1, Math.ceil(bit.size / 32));

  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const component = new Map<number, number>();
  const labels: Uint32Array[] = [];

  const closeComponent = (root: number): void => {
    const label = new Uint32Array(words);
    const members: number[] = [];
    let member: number;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      members.push(member);
    } while (member !== root);
    const id = labels.length;
    for (const node of members) component.set(node, id);
    for (const node of members) {
      const own = bit.get(node);
      if (own !== undefined) label[own >>> 5]! |= 1 << (own & 31);
      // Every edge leaving the component points at one Tarjan already closed.
      for (const edge of edgesOf(node)) {
        const target = component.get(edge);
        if (target === undefined || target === id) continue;
        const inherited = labels[target]!;
        for (let word = 0; word < words; word++) label[word]! |= inherited[word]!;
      }
    }
    labels.push(label);
  };

  // Iterative Tarjan: a deep promise chain must not overflow the JS stack.
  for (const start of starts) {
    if (index.has(start)) continue;
    const frames: Array<{ node: number; edges: readonly number[]; next: number }> = [];
    const open = (node: number): void => {
      index.set(node, index.size);
      low.set(node, index.get(node)!);
      stack.push(node);
      onStack.add(node);
      frames.push({ node, edges: edgesOf(node), next: 0 });
    };
    open(start);
    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      if (frame.next < frame.edges.length) {
        const edge = frame.edges[frame.next++]!;
        if (!index.has(edge)) open(edge);
        else if (onStack.has(edge)) low.set(frame.node, Math.min(low.get(frame.node)!, index.get(edge)!));
        continue;
      }
      frames.pop();
      const parent = frames.at(-1);
      if (parent !== undefined) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) === index.get(frame.node)) closeComponent(frame.node);
    }
  }

  const reached = new Map<number, ReadonlySet<number>>();
  for (const start of starts) {
    if (reached.has(start)) continue;
    const label = labels[component.get(start)!]!;
    const found = new Set<number>();
    for (const [target, position] of bit) {
      if ((label[position >>> 5]! & (1 << (position & 31))) !== 0) found.add(target);
    }
    reached.set(start, found);
  }
  return reached;
}
