import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

// An explicit argv contract avoids treating prose or arbitrary backticked
// snippets as shell commands. Checks are authored before implementation.
export function verificationCommands(body) {
  const lines = body.split('\n').filter(line => /^\s*Verify:/.test(line));
  return lines.map(line => {
    let argv;
    try { argv = JSON.parse(line.replace(/^\s*Verify:\s*/, '')); }
    catch { throw new Error('INVALID_EXECUTABLE_CHECK: Verify must contain a JSON argv array'); }
    assert(Array.isArray(argv) && argv.length > 0 &&
      argv.every(arg => typeof arg === 'string' && !arg.includes('\0')) && argv[0].trim(),
    'INVALID_EXECUTABLE_CHECK: expected nonempty command argv');
    return argv;
  });
}

const protectedPaths = [
  'ops/BACKLOG.md', 'ops/local-work-package.mjs', 'ops/local-work-verification.mjs',
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
            if (error.code === 'ENOENT') continue; // dangling: writes cannot escape through it
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
  assert(pkg.verificationCommands?.length > 0, 'MISSING_EXECUTABLE_CHECKS');
  for (const argv of pkg.verificationCommands) {
    console.log(`CHECK ${JSON.stringify(argv)}`);
    const result = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', timeout: 120000 });
    assert(!result.error && result.status === 0,
      `PACKAGE_CHECK_FAILED: ${JSON.stringify(argv)} (${result.error?.message ?? result.signal ?? result.status})`);
  }
  console.log(`PACKAGE_VERIFIED: ${pkg.verificationCommands.length} check(s)`);
}
