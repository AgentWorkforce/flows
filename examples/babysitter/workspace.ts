import type { Ctx } from '@relayflows/surface';
import { shellWord, type Config } from './input.ts';
import type { State } from './state.ts';
/** Worktree is outside the PR so its scratch cannot be supplied as a symlink by the PR. */
export async function capture(f: Ctx, c: Config, s: State, head: string): Promise<string> {
  const dir = (await f.run('mktemp -d /tmp/babysitter.XXXXXXXX')).trim();
  if (!/^\/tmp\/babysitter\.[A-Za-z0-9]+$/.test(dir)) throw new Error('Invalid scratch directory');
  const pinned = shellWord(head), base = shellWord(String(s.baseSha));
  // Explicit repository URL: never trust a PR-controlled remote configuration.
  await f.run(`git -c core.hooksPath=/dev/null clone --no-checkout --no-local ${shellWord(`https://github.com/${c.owner}/${c.repo}.git`)} ${shellWord(`${dir}/repo`)} && cd ${shellWord(`${dir}/repo`)} && git -c core.hooksPath=/dev/null fetch --no-tags origin ${pinned} ${base} && git -c core.hooksPath=/dev/null checkout --detach ${pinned} && test "$(git rev-parse HEAD)" = ${pinned} && git diff --no-ext-diff --no-textconv ${base}...${pinned} > ${shellWord(`${dir}/diff.patch`)} && git log --format='%H %s' -30 ${pinned} > ${shellWord(`${dir}/history.txt`)}`, { timeout: '5m' });
  return dir;
}
export async function assertUntouched(f: Ctx, dir: string, sha: string): Promise<void> {
  await f.run(`cd ${shellWord(`${dir}/repo`)} && test "$(git rev-parse HEAD)" = ${shellWord(sha)} && test -z "$(git status --porcelain --untracked-files=all)"`, { timeout: '1m' });
}
export async function validate(f: Ctx, dir: string, command: string): Promise<boolean> {
  // Full transcript remains an artifact; only our fixed sentinel crosses stdout.
  const result = await f.run(`cd ${shellWord(`${dir}/repo`)} && if /bin/sh -c ${shellWord(command)} > ${shellWord(`${dir}/validation.log`)} 2>&1; then printf PASS; else printf FAIL; fi`, { timeout: '15m' });
  return result === 'PASS';
}
