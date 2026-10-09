import type { Ctx } from '@relayflows/surface';
import { nodeCommand } from './github.ts';

// Both functions below are stringified by `nodeCommand` and run by `node -e`
// inside an `f.run` step, never in this process (see github.ts). They load
// builtins with `import()`: a bundler rewrites `require` into a shim that does
// not exist once the function's source is lifted out of the bundle.
declare const process: { env: Record<string, string | undefined>; stdout: { write(chunk: string): void } };
declare const Buffer: { byteLength(value: string): number; from(value: string): { toString(encoding: string): string } };

/** The proposal is one step's stdout: it must fit the journal's output tail. */
export const PROPOSAL_MAX_BYTES = 50_000;
export const PATCH_MAX_BYTES = 36_000;
export const PATCH_MAX_FILES = 50;
export const REPLY_MAX_CHARS = 1_000;
export const SUMMARY_MAX_CHARS = 4_000;

/**
 * Paths a proposal may never touch: CI workflows (a push there would run with
 * repository secrets) and secret material. Cloud re-checks the same rule
 * server-side before it pushes; this copy only fails a run early.
 */
export const REFUSED_PATHS = String.raw`^\.github/workflows/|(^|/)\.env($|\.)|\.(pem|key|p12|pfx|jks)$|(^|/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|(^|/)\.(npmrc|netrc|pypirc)$|(^|/)secrets?/`;

/**
 * Check out exactly `head` into `babysitter-checkout` under the run root, with
 * the run's read-only token sent as a header (never in argv or git config).
 * An existing checkout (a reused sandbox) is fetched and reset in place;
 * ignored files such as installed dependencies are kept.
 */
export async function checkoutHead(c: { owner: string; repo: string; head: string }): Promise<void> {
  const { execFileSync } = await import('node:child_process');
  const { existsSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN required');
  const dir = resolve('babysitter-checkout');
  const auth = Buffer.from(`x-access-token:${process.env.GH_TOKEN}`).toString('base64');
  const env = {
    ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${auth}`,
    GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null',
    GIT_CONFIG_KEY_2: 'advice.detachedHead', GIT_CONFIG_VALUE_2: 'false',
  };
  const git = (...args: string[]) => String(execFileSync('git', ['-C', dir, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
  const reused = existsSync(`${dir}/.git`);
  if (!reused) { mkdirSync(dir, { recursive: true }); git('init', '-q'); }
  // A previous agent turn could write .git: drop its config, hooks and
  // attribute overrides before git runs with the token.
  writeFileSync(`${dir}/.git/config`, '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n');
  rmSync(`${dir}/.git/hooks`, { recursive: true, force: true });
  rmSync(`${dir}/.git/info/attributes`, { force: true });
  git('fetch', '-q', '--no-tags', '--depth=50', `https://github.com/${c.owner}/${c.repo}.git`, c.head);
  git('checkout', '-q', '--force', '--detach', c.head);
  git('reset', '-q', '--hard', c.head);
  git('clean', '-q', '-fd');
  if (git('rev-parse', 'HEAD') !== c.head) throw new Error('Checkout is not at the bound head');
  process.stdout.write(JSON.stringify({ dir, head: c.head, reused }));
}

export interface ProposalInput {
  dir: string; head: string; pullRequest: { owner: string; repo: string; number: number };
  summary: string; replies: { commentId: number; body: string }[];
  limits: { patchBytes: number; files: number; proposalBytes: number; refused: string };
}

/**
 * Turn the agent's working-tree change (commits included: the diff is taken
 * against the bound head) into the run's one proposal: a bounded binary-safe
 * patch plus thread replies. Prints the proposal, or a refusal, as JSON. It
 * never commits or pushes; Cloud publishes a proposal server-side.
 */
export async function proposeChanges(c: ProposalInput): Promise<void> {
  const { execFileSync } = await import('node:child_process');
  const { rmSync, writeFileSync } = await import('node:fs');
  // The agent could write .git: an external diff, a clean filter or a hook
  // would otherwise run here, and its diff settings would change the patch
  // format Cloud parses. Reset them before git runs.
  writeFileSync(`${c.dir}/.git/config`, '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n');
  rmSync(`${c.dir}/.git/hooks`, { recursive: true, force: true });
  rmSync(`${c.dir}/.git/info/attributes`, { force: true });
  const git = (...args: string[]) => String(execFileSync('git', ['-C', c.dir, ...args], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null', GIT_CONFIG_KEY_1: 'core.quotePath', GIT_CONFIG_VALUE_1: 'false' },
  }));
  const diff = ['diff', '--cached', '--no-renames', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];
  const refuse = (reason: string) => process.stdout.write(JSON.stringify({ kind: 'babysitter-refusal', reason }));
  git('add', '-A');
  // NUL-delimited: a newline in a name cannot split it. A name git would
  // have to quote in the patch is refused outright, so the paths Cloud parses
  // back out of the patch are exactly these.
  const files = git(...diff, '-z', '--name-only', c.head).split('\0').filter(Boolean);
  const quoted = files.filter(f => /["\\\x00-\x1f\x7f]/.test(f));
  if (quoted.length) return refuse(`changes ${quoted.length} path(s) with quotes, backslashes or control characters`);
  const refused = files.filter(f => new RegExp(c.limits.refused).test(f));
  if (refused.length) return refuse(`changes refused paths: ${refused.slice(0, 5).join(', ')}`);
  if (files.length > c.limits.files) return refuse(`changes ${files.length} files; at most ${c.limits.files}`);
  const patch = git(...diff, '--binary', '--full-index', c.head);
  if (Buffer.byteLength(patch) > c.limits.patchBytes) return refuse(`patch is ${Buffer.byteLength(patch)} bytes; at most ${c.limits.patchBytes}`);
  const out = JSON.stringify({
    kind: 'babysitter-proposal', schemaVersion: 1, pullRequest: c.pullRequest, baseHead: c.head,
    files, patch, summary: c.summary, replies: c.replies,
  });
  if (Buffer.byteLength(out) > c.limits.proposalBytes) return refuse('proposal exceeds the journal output bound');
  process.stdout.write(out);
}

export async function checkout(f: Ctx, pr: { owner: string; repo: string }, head: string): Promise<{ dir: string; reused: boolean }> {
  const value = JSON.parse(await f.run(nodeCommand(checkoutHead, { owner: pr.owner, repo: pr.repo, head }), { timeout: '5m' }));
  if (value.head !== head || typeof value.dir !== 'string') throw new Error('Checkout did not report the bound head');
  return { dir: value.dir, reused: value.reused === true };
}

export type Proposal =
  | { kind: 'babysitter-proposal'; files: string[]; patch: string }
  | { kind: 'babysitter-refusal'; reason: string };

export async function propose(f: Ctx, input: Omit<ProposalInput, 'limits'>): Promise<Proposal> {
  const value = JSON.parse(await f.run(nodeCommand(proposeChanges, {
    ...input,
    limits: { patchBytes: PATCH_MAX_BYTES, files: PATCH_MAX_FILES, proposalBytes: PROPOSAL_MAX_BYTES, refused: REFUSED_PATHS },
  }), { timeout: '2m' }));
  if (value.kind === 'babysitter-refusal' && typeof value.reason === 'string') return value;
  if (value.kind !== 'babysitter-proposal' || value.baseHead !== input.head || !Array.isArray(value.files) || typeof value.patch !== 'string')
    throw new Error('Proposal step returned a malformed proposal');
  return value;
}
