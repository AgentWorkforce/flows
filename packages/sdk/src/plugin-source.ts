import { safePath } from './bundle.js';
import { PluginError } from './plugin-manifest.js';

/**
 * Where a flow-extension plugin comes from: a public GitHub repository, pinned
 * to a commit. A branch or tag is accepted as *input* only; what gets written
 * to `flows.json` and the lockfile is always the canonical 40-hex form,
 * `github:<owner>/<repo>@<sha>#<path>`, so a later reader can never resolve
 * to different bytes than the installer saw.
 */
export interface PluginSourceInput {
  readonly host: 'github';
  readonly owner: string;
  readonly repo: string;
  /** Branch, tag, or commit as typed. */
  readonly ref: string;
  /** Directory inside the repository holding `flows-plugin.json`; `''` is the root. */
  readonly path: string;
}
export interface PluginSourceRef extends PluginSourceInput {
  /** Exactly 40 lowercase hex characters. */
  readonly sha: string;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
export const SHA = /^[0-9a-f]{40}$/;

function invalid(message: string): never {
  throw new PluginError('plugin_source_invalid', message);
}

export function isGithubPluginRef(value: string): boolean {
  return value.startsWith('github:') || /^https:\/\/github\.com\//.test(value);
}

/**
 * Accepts `github:<owner>/<repo>@<ref>#<path>`,
 * `https://github.com/<owner>/<repo>/tree/<ref>/<path>` (or `/blob/`), and
 * `github:<owner>/<repo>@<ref>` for a root-level plugin.
 *
 * In the URL form the ref is the single segment after `tree/`: GitHub itself
 * disambiguates `tree/feat/x/dir` against the repository's refs, which an
 * offline parser cannot. A ref containing `/` must use the `github:` form,
 * where `@ref#path` is unambiguous.
 */
export function parsePluginSource(input: string): PluginSourceInput {
  if (input.length > 2048) return invalid('Plugin source is too long.');
  let owner: string | undefined, repo: string | undefined, ref: string | undefined, path = '';
  if (input.startsWith('github:')) {
    const m = /^github:([^/@#]+)\/([^/@#]+)@([^#]+)(?:#(.*))?$/.exec(input);
    if (!m) return invalid('Expected github:<owner>/<repo>@<ref>[#<path>].');
    [, owner, repo, ref] = m;
    path = m[4] ?? '';
  } else if (/^https:\/\/github\.com\//.test(input)) {
    let url: URL;
    try { url = new URL(input); } catch { return invalid('Plugin source is not a valid URL.'); }
    if (url.username || url.password || url.search || url.hash) return invalid('Plugin URL must not carry credentials, a query, or a fragment.');
    const m = /^\/([^/]+)\/([^/]+)\/(?:tree|blob)\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!m) return invalid('Expected https://github.com/<owner>/<repo>/tree/<ref>/<path>.');
    [, owner, repo, ref] = m.map(part => part === undefined ? part : decodeURIComponent(part));
    path = m[4] === undefined ? '' : decodeURIComponent(m[4]);
  } else return invalid('Expected a github: reference or a https://github.com/ URL.');
  if (owner === undefined || !OWNER.test(owner)) return invalid('Invalid GitHub owner.');
  if (repo === undefined || !REPO.test(repo) || repo === '.' || repo === '..') return invalid('Invalid GitHub repository name.');
  if (repo.endsWith('.git')) repo = repo.slice(0, -4);
  if (ref === undefined || !REF.test(ref) || ref.includes('..') || ref.endsWith('/') || ref.endsWith('.lock')) return invalid('Invalid git ref.');
  path = path.replace(/\/+$/, '');
  if (path !== '' && !safePath(path)) return invalid('Plugin path must be repository-relative without traversal.');
  if (path.split('/').some(part => part === 'flows-plugin.json')) return invalid('Plugin path names the directory holding flows-plugin.json, not the file.');
  return Object.freeze({ host: 'github', owner, repo, ref, path });
}

/** The one spelling that is ever persisted. */
export function canonicalPluginRef(source: PluginSourceRef): string {
  return `github:${source.owner}/${source.repo}@${source.sha}${source.path === '' ? '' : `#${source.path}`}`;
}

/** Parses a persisted reference; refuses anything but the canonical sha form. */
export function parseCanonicalPluginRef(value: string): PluginSourceRef {
  const parsed = parsePluginSource(value);
  if (!value.startsWith('github:') || !SHA.test(parsed.ref)) {
    throw new PluginError('plugin_source_invalid', `Persisted plugin reference must be github:<owner>/<repo>@<sha>[#<path>], got ${value}.`);
  }
  return Object.freeze({ ...parsed, sha: parsed.ref });
}
