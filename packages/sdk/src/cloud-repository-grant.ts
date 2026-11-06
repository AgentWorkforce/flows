import { isCloudRecord } from './cloud-http.js';

export interface CloudRepositoryGrant {
  host?: 'gitlab';
  owner: string;
  repo: string;
  baseBranch: string;
  baseSha: string;
  branch: string;
  mode?: 'head';
  workflows?: true;
  access?: 'read';
}

const coordinate = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u;

function validGitlabNamespace(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 255) return false;
  const parts = value.split('/');
  return parts.length >= 1 && parts.length <= 20 && parts.every(part => (
    coordinate.test(part) && !part.endsWith('.') && !part.endsWith('.git') && !part.endsWith('.atom')
  ));
}

function validRepositoryBranch(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(value)
    && value !== 'HEAD'
    && !value.includes('..')
    && !value.includes('//')
    && value.split('/').every(part => (
      part !== '' && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')
    ));
}

/**
 * Rebuild the request portion of persisted Cloud repository authority.
 * Cloud re-admits this request against the persisted identity and current
 * connection; the SDK must neither infer missing authority nor widen it.
 */
export function readCloudRepositoryGrant(value: unknown): CloudRepositoryGrant | undefined {
  if (value === undefined) return undefined;
  if (!isCloudRecord(value)) return undefined;
  const gitlab = value.host === 'gitlab';
  if ((value.host !== undefined && value.host !== 'github' && value.host !== 'gitlab')
    || typeof value.owner !== 'string'
    || !(gitlab ? validGitlabNamespace(value.owner) : coordinate.test(value.owner))
    || typeof value.repo !== 'string'
    || !/^[A-Za-z0-9_.-]{1,100}$/u.test(value.repo)
    || value.repo === '.' || value.repo === '..'
    || (gitlab && (value.repo.endsWith('.git') || value.repo.endsWith('.atom') || value.repo.endsWith('.')))
    || !validRepositoryBranch(value.baseBranch)
    || !validRepositoryBranch(value.branch)
    || (value.mode !== undefined && value.mode !== 'new' && value.mode !== 'head')
    || (value.workflows !== undefined && typeof value.workflows !== 'boolean')
    || (gitlab && value.workflows === true)
    || (value.access !== undefined && value.access !== 'read')
    || (value.access === 'read' && value.workflows === true)
    || (gitlab && value.access === 'read')
    || (value.mode !== 'head' && !value.branch.startsWith('relayflow/'))
    || value.branch === value.baseBranch
    || typeof value.baseSha !== 'string'
    || !/^[a-f0-9]{40}$/u.test(value.baseSha)) {
    return undefined;
  }
  return {
    ...(gitlab ? { host: 'gitlab' as const } : {}),
    owner: value.owner.toLowerCase(),
    repo: value.repo.toLowerCase(),
    baseBranch: value.baseBranch,
    baseSha: value.baseSha,
    branch: value.branch,
    ...(value.mode === 'head' ? { mode: 'head' as const } : {}),
    ...(value.workflows === true ? { workflows: true as const } : {}),
    ...(value.access === 'read' ? { access: 'read' as const } : {}),
  };
}
