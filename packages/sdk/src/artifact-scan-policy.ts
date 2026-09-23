/**
 * The bundled agent worker's artifact-scan policy, as a pure predicate.
 *
 * `agent-artifacts.ts` walks an agent step's cwd and records every regular
 * file it finds, except entries named exactly `.git`, `.relayflowd` or
 * `node_modules` — files as well as directories, in both cases. Dotfiles and
 * dot-directories ARE eligible: `.workflow-artifacts/` is the conventional
 * place a flow tells its agents to write. What that walk records is one
 * source of the journaled `output.artifacts` list, which is the only thing an
 * `artifact_exists` gate reads (`named-gate-lowering.ts` tests exact
 * membership in that list and never touches disk).
 *
 * Static analysis needs the same rule without importing filesystem traversal,
 * so the rule lives here and both consume it. It bounds the *scan*, not the
 * list: `worker.ts` journals object-shaped JSON stdout and completed Relay
 * task output verbatim instead of the scanned wrapper, and
 * `JournalClient.stepComplete` accepts any `output` from any worker — so a
 * path this predicate excludes can still reach the list by those routes
 * (`named-gate-preflight.ts` warns rather than refusing for exactly that
 * reason).
 */

/**
 * Entry names the walk never descends into or records, matched exactly, at
 * any depth, before the entry's type is consulted — so a `.git` *file* (a
 * worktree's gitdir pointer) is skipped as surely as a `.git` directory.
 * Exact names, not prefixes: `.github`, `.relayflowd-notes` and every other
 * author-chosen name that merely starts the same way stays eligible.
 */
const SKIPPED_ENTRY_NAMES = new Set(['.git', '.relayflowd', 'node_modules']);

export function isUnscannedEntryName(name: string): boolean {
  return SKIPPED_ENTRY_NAMES.has(name);
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
