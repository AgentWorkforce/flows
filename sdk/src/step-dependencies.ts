/** Return author-facing dependency errors without assuming parsed step shapes. */
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
          `spec.steps: dependency cycle detected at "${dependency}" (path: ${path.join(' -> ')} -> ${dependency})`,
        );
      } else if (dependencyColor === WHITE) {
        color.set(dependency, GRAY);
        path.push(dependency);
        frames.push({ id: dependency, nextDependency: 0 });
      }
    }
  }
  return errors;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
