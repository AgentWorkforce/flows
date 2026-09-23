import { describe, expect, it } from 'vitest';
import { reachableTargets } from '../src/promise-ancestry.js';

/** Edges point from a promise to what it depends on, as the promise graph's do. */
function graph(edges: Record<number, number[]>) {
  return (node: number): readonly number[] => edges[node] ?? [];
}

/** The pairwise definition the batch pass must agree with. */
function walk(start: number, edgesOf: (node: number) => readonly number[]): Set<number> {
  const found = new Set<number>();
  const stack = [start];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (found.has(node)) continue;
    found.add(node);
    stack.push(...edgesOf(node));
  }
  return found;
}

describe('reachableTargets', () => {
  it('matches a pairwise walk, a node reaching itself, across a cycle', () => {
    // 5 -> 4 -> 3 -> 4 (cycle via a resolution cause), 3 -> 1, 5 -> 2; 6 is unrelated.
    const edgesOf = graph({ 5: [4, 2], 4: [3], 3: [4, 1], 6: [7] });
    const targets = [1, 2, 3, 4, 5, 6, 7, 99];
    const reached = reachableTargets([5, 4, 3, 6, 1], targets, edgesOf);
    for (const start of [5, 4, 3, 6, 1]) {
      const expected = [...walk(start, edgesOf)].filter((node) => targets.includes(node));
      expect([...reached.get(start)!].sort()).toEqual(expected.sort());
    }
    expect(reached.get(5)).toEqual(new Set([1, 2, 3, 4, 5]));
    expect(reached.get(4)).toEqual(new Set([1, 3, 4]));
  });

  it('handles more than 32 targets and a chain too deep for recursion', () => {
    const depth = 200_000;
    const edgesOf = (node: number): readonly number[] => (node > 0 ? [node - 1] : []);
    const targets = Array.from({ length: 70 }, (_, index) => index * 1_000);
    const reached = reachableTargets([depth, 35_500], targets, edgesOf);
    expect(reached.get(depth)!.size).toBe(70);
    expect([...reached.get(35_500)!].sort((a, b) => a - b)).toEqual(targets.slice(0, 36));
  });
});
