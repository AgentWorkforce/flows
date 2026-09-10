import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { runAcceptance } from './local-work-acceptance.mjs';

const protectedPaths = [
  'ops/BACKLOG.md', 'ops/local-work-package.mjs', 'ops/local-work-verification.mjs',
  'ops/local-work-gate.mjs', 'ops/local-work-snapshot.mjs', 'scripts/run-drive-local.mjs',
  'ops/local-work-acceptance.mjs',
  'workflows/drive-local.yaml', 'workflows/gates', 'packages/sdk/src/backlog-picker.ts',
];
const within = (path, scope) => path === scope || path.startsWith(`${scope}/`);
const gitPaths = (...args) => execFileSync('git', args, { encoding: 'utf8' }).split('\0').filter(Boolean);

export function checkScope(pkg) {
  const root = realpathSync('.');
  const scopes = pkg.filesInScope.map(path => {
    const normalized = path.replace(/\/$/, '');
    assert(normalized && !normalized.startsWith('/') &&
      normalized.split('/').every(part => part && part !== '.' && part !== '..'),
    `INVALID_SCOPE: ${path}`);
    const kind = execFileSync('git', ['cat-file', '-t', `${pkg.head}:${normalized}`],
      { encoding: 'utf8' }).trim();
    return { path: normalized, directory: kind === 'tree' };
  });
  // A declared DIRECTORY scope is an authorization to write anywhere beneath it,
  // so its descendants have to be sound before any check runs -- not just the
  // paths that happen to be touched. A pre-existing symlink inside such a scope
  // is never "touched", so the per-path walk below never sees it, and a Verify
  // command can write straight through it to somewhere outside the checkout.
  // Symlinks that stay inside the root are left alone: workspace layouts use
  // them legitimately, and the threat is escape, not indirection.
  for (const scope of scopes.filter(s => s.directory)) {
    const stack = [scope.path];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
        throw error;
      }
      for (const entry of entries) {
        if (entry.name === '.git') continue;
        const child = `${dir}/${entry.name}`;
        if (entry.isSymbolicLink()) {
          let target;
          try {
            target = realpathSync(child);
          } catch (error) {
            // O_CREAT follows dangling links too. Without a resolvable target
            // we cannot prove containment, so refuse before running checks.
            if (error.code === 'ENOENT') throw new Error(`SYMLINK_UNRESOLVED: ${child}`, { cause: error });
            throw error;
          }
          assert(target === root || target.startsWith(`${root}${sep}`),
            `SYMLINK_ESCAPES_SCOPE: ${child} -> ${target}`);
        } else if (entry.isDirectory()) {
          stack.push(child);
        }
      }
    }
  }
  // Check index and working tree separately: a staged edit followed by an
  // unstaged reversal must not disappear. --no-renames exposes both endpoints.
  const touched = new Set([
    ...gitPaths('diff', '--name-only', '--no-renames', '-z', pkg.head, '--'),
    ...gitPaths('diff', '--cached', '--name-only', '--no-renames', '-z', pkg.head, '--'),
    ...gitPaths('ls-files', '--others', '--exclude-standard', '-z'),
  ]);
  for (const path of touched) {
    assert(!protectedPaths.some(scope => within(path, scope)) &&
      scopes.some(scope => path === scope.path || (scope.directory && within(path, scope.path))),
    `OUT_OF_SCOPE: ${path}`);
    // Reject symlinks, including an ancestor replaced by a symlink, so a
    // lexical prefix cannot authorize writing outside the checkout.
    let current = root;
    for (const part of path.split('/')) {
      current = resolve(current, part);
      try {
        assert(!lstatSync(current).isSymbolicLink(), `SYMLINK_SCOPE: ${path}`);
        assert(realpathSync(current).startsWith(`${root}${sep}`), `OUT_OF_SCOPE: ${path}`);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') break; // deletion
        throw error;
      }
    }
  }
  console.log(`SCOPE_OK: ${touched.size} changed path(s)`);
}

export function runChecks(pkg) {
  runAcceptance(pkg);
}
