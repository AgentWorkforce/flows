import { isCloudRecord } from './cloud-http.js';

/**
 * What a Cloud write did to a listener's active version (cloud#4115).
 * `reactivated`: the bytes match an earlier version, so the pointer moved to
 * it without a new row, and `version` can be LOWER than `previousVersion`.
 */
export interface CloudFlowVersionChange {
  version: number;
  previousVersion: number | null;
  change: 'created' | 'reactivated' | 'unchanged';
}

export interface CloudFlowVersion {
  version: number;
  sourceSha256: string;
  origin: string;
  createdAt: string;
}

const CHANGES = ['created', 'reactivated', 'unchanged'] as const;

function isVersionNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** Undefined for a Cloud that predates versions or a malformed field. */
export function parseVersionChange(value: unknown): CloudFlowVersionChange | undefined {
  if (!isCloudRecord(value) || !isVersionNumber(value.version)
    || !(value.previousVersion === null || isVersionNumber(value.previousVersion))
    || !(CHANGES as readonly unknown[]).includes(value.change)) return undefined;
  return {
    version: value.version,
    previousVersion: value.previousVersion as number | null,
    change: value.change as CloudFlowVersionChange['change'],
  };
}

export function parseVersion(value: unknown): CloudFlowVersion | undefined {
  if (!isCloudRecord(value) || !isVersionNumber(value.version) || typeof value.sourceSha256 !== 'string'
    || typeof value.origin !== 'string' || typeof value.createdAt !== 'string') return undefined;
  return { version: value.version, sourceSha256: value.sourceSha256, origin: value.origin, createdAt: value.createdAt };
}

/**
 * `version 4 (was 3)`; a rollback by content says the number went down, so
 * nobody reads v2-after-v3 as a failed deploy.
 */
export function describeVersionChange(change: CloudFlowVersionChange): string {
  if (change.change === 'unchanged') return `version ${change.version} (unchanged)`;
  const was = change.previousVersion === null ? '' : ` (was ${change.previousVersion}`;
  if (change.change === 'reactivated') {
    const down = change.previousVersion !== null && change.version < change.previousVersion
      ? '; active version went down' : '';
    return `re-activated version ${change.version}${was}${down}${was ? ')' : ''}`;
  }
  return `version ${change.version}${was}${was ? ')' : ''}`;
}
