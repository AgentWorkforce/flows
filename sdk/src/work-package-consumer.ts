import { existsSync } from 'node:fs';

/** The work-package shape emitted at the SDK boundary. */
export interface EmittedWorkPackage {
  title: string;
  files_in_scope: string[];
  definition_of_done: string[];
  description?: string;
  gate?: number | null;
}

export type WorkPackageRefusalReason =
  | 'missing_title'
  | 'missing_scope'
  | 'missing_definition_of_done'
  | 'nonexistent_files';

export type WorkPackageConsumption =
  | { accepted: true; work: EmittedWorkPackage }
  | { accepted: false; reason: WorkPackageRefusalReason };

/** Resolve a scoped path; used to check that scoped files are really there. */
export type PathExists = (path: string) => boolean;

/** Default: ask the filesystem. Injectable so the check is testable. */
const defaultPathExists: PathExists = (path) => existsSync(path);

/**
 * Validate an emitted package before admitting it as runnable work.
 * Refusals are data so callers must handle an unverifiable package explicitly.
 *
 * The existence check is ON by default — review rejected making it opt-in
 * (PR #28, P1): a caller using the one-argument API would silently skip it, so
 * the guard would not guard. `pathExists` defaults to the real filesystem and
 * is injectable purely so the behaviour can be tested without one. A package
 * scoping files that are not there is refused: the picker derives files_in_scope from prose
 * in ops/BACKLOG.md, so a stale or mistyped entry produces a package that reads
 * as actionable and sends whoever picks it up looking for something that does
 * not exist. Checking is cheap; a wrong scope is not.
 */
export function consumeWorkPackage(
  input: unknown,
  pathExists: PathExists = defaultPathExists,
): WorkPackageConsumption {
  if (!isRecord(input) || !isNonEmptyString(input['title'])) {
    return { accepted: false, reason: 'missing_title' };
  }
  if (!isNonEmptyStringArray(input['files_in_scope'])) {
    return { accepted: false, reason: 'missing_scope' };
  }
  if (isNonEmptyStringArray(input['files_in_scope'])) {
    const missing = input['files_in_scope'].filter((p) => !pathExists(p));
    if (missing.length > 0) {
      return { accepted: false, reason: 'nonexistent_files' };
    }
  }
  if (!isNonEmptyStringArray(input['definition_of_done'])) {
    return { accepted: false, reason: 'missing_definition_of_done' };
  }
  return { accepted: true, work: input as unknown as EmittedWorkPackage };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}
