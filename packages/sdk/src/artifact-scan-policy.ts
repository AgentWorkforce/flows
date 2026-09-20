/**
 * The bundled agent worker's artifact-scan policy, as a pure predicate.
 *
 * `agent-artifacts.ts` walks an agent step's cwd and records every regular
 * file it finds, except entries whose name starts with `.` and entries named
 * exactly `node_modules` — files as well as directories, in both cases. That
 * walk decides what lands in the journaled `output.artifacts` list, which is
 * the only thing an `artifact_exists` gate reads (`named-gate-lowering.ts`
 * tests exact membership in that list and never touches disk).
 *
 * Static analysis needs the same rule without importing filesystem traversal,
 * so the rule lives here and both consume it. This is a property of the
 * bundled worker, not of the journal protocol: `JournalClient.stepComplete`
 * accepts any `output`, so a custom worker is free to journal a hidden path.
 */

/** Entry names the walk never descends into or records. */
const SKIPPED_ENTRY_NAMES = new Set(['node_modules']);

export function isUnscannedEntryName(name: string): boolean {
  return name.startsWith('.') || SKIPPED_ENTRY_NAMES.has(name);
}

/**
 * The shortest `/`-prefix of a relative POSIX `path` the scan excludes, or
 * `undefined` when every segment is scanned.
 *
 * Segments are compared exactly, with no normalization: the gate matches the
 * author's literal string against the worker's literal list, so `node_modules`
 * is excluded and `node_modules-copy` is not, and a backslash is an ordinary
 * filename character rather than a separator. The whole prefix is returned,
 * not the offending segment alone, because that prefix is the directory an
 * author has to move the artifact out of.
 */
export function unscannedArtifactPrefix(path: string): string | undefined {
  const segments = path.split('/');
  const index = segments.findIndex(isUnscannedEntryName);
  return index === -1 ? undefined : segments.slice(0, index + 1).join('/');
}
