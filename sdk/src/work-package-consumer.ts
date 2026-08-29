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
  | 'nonexistent_files'
  | 'missing_definition_of_done';

export type WorkPackageConsumption =
  | { accepted: true; work: EmittedWorkPackage }
  | { accepted: false; reason: WorkPackageRefusalReason };

/**
 * Validate an emitted package before admitting it as runnable work.
 * Refusals are data so callers must handle an unverifiable package explicitly.
 */
export function consumeWorkPackage(input: unknown): WorkPackageConsumption {
  if (!isRecord(input) || !isNonEmptyString(input['title'])) {
    return { accepted: false, reason: 'missing_title' };
  }
  if (!isNonEmptyStringArray(input['files_in_scope'])) {
    return { accepted: false, reason: 'missing_scope' };
  }
  if (!isNonEmptyStringArray(input['definition_of_done'])) {
    return { accepted: false, reason: 'missing_definition_of_done' };
  }
  if (!input['files_in_scope'].every((path) => existsSync(path))) {
    return { accepted: false, reason: 'nonexistent_files' };
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
