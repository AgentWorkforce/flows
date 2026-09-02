/** Return author-facing dependency errors without assuming parsed step shapes. */
const MAX_REPORTED_CYCLE_PATH_IDS = 16;

export function stepDependencyErrors(
  steps: readonly unknown[],
  knownIds: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  const adjacency = new Map<string, string[]>();

  for (const value of steps) {
    // The main validator reports the shape error. This pass must not replace
    // that typed result by dereferencing or iterating a malformed value.
    if (!isObject(value) || !isNonEmptyString(value['id'])) continue;
    const rawDependencies = value['dependsOn'];
    if (
      rawDependencies !== undefined
      && (!Array.isArray(rawDependencies) || !rawDependencies.every(isNonEmptyString))
    ) {
      continue;
    }

    const id = value['id'];
    const dependencies = (rawDependencies ?? []) as string[];
    for (const dependency of dependencies) {
      if (!knownIds.has(dependency)) {
        errors.push(`spec.steps: step "${id}" dependsOn unknown step "${dependency}"`);
      }
    }
    adjacency.set(id, dependencies);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of adjacency.keys()) color.set(id, WHITE);
  const path: string[] = [];
  for (const start of adjacency.keys()) {
    if (color.get(start) !== WHITE) continue;

    color.set(start, GRAY);
    path.push(start);
    const frames: Array<{ id: string; nextDependency: number }> = [
      { id: start, nextDependency: 0 },
    ];

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame === undefined) break;
      const dependencies = adjacency.get(frame.id) ?? [];
      const dependency = dependencies[frame.nextDependency];

      if (dependency === undefined) {
        frames.pop();
        path.pop();
        color.set(frame.id, BLACK);
        continue;
      }

      frame.nextDependency += 1;
      const dependencyColor = color.get(dependency);
      if (dependencyColor === GRAY) {
        errors.push(
          `spec.steps: dependency cycle detected at "${dependency}" (path: ${formatCyclePath(path, dependency)})`,
        );
        // One deterministic back edge proves the graph is invalid. Continuing
        // would report every remaining gray edge and amplify diagnostics
        // cubically for dense graphs, unlike the kernel's first-cycle refusal.
        return errors;
      } else if (dependencyColor === WHITE) {
        color.set(dependency, GRAY);
        path.push(dependency);
        frames.push({ id: dependency, nextDependency: 0 });
      }
    }
  }
  return errors;
}

function formatCyclePath(path: readonly string[], dependency: string): string {
  const cycleStart = path.lastIndexOf(dependency);
  const cycle = [...path.slice(cycleStart), dependency];
  if (cycle.length <= MAX_REPORTED_CYCLE_PATH_IDS) return cycle.join(' -> ');

  const headSize = MAX_REPORTED_CYCLE_PATH_IDS / 2;
  const tailSize = MAX_REPORTED_CYCLE_PATH_IDS - headSize;
  const omitted = cycle.length - MAX_REPORTED_CYCLE_PATH_IDS;
  return [
    ...cycle.slice(0, headSize),
    `... (${omitted} steps omitted) ...`,
    ...cycle.slice(-tailSize),
  ].join(' -> ');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
