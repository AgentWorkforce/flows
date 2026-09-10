// Acceptance code has a separate ownership contract from implementation data.
// Git inputs are extracted afresh; external inputs must be outside write scope.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const violation = detail => `ACCEPTANCE_IMMUTABILITY_VIOLATION: ${detail}`;
const within = (path, root) => path === root || path.startsWith(`${root}${sep}`);
const git = (...args) => execFileSync('git', ['--no-replace-objects', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });

export function acceptanceContract(body, ref) {
  const checks = body.split('\n').filter(line => /^\s*Verify:/.test(line)).map(line => {
    let declaration;
    try { declaration = JSON.parse(line.replace(/^\s*Verify:\s*/, '')); }
    catch { throw new Error('INVALID_EXECUTABLE_CHECK: Verify must contain JSON argv or {argv, inputs}'); }
    assert(Array.isArray(declaration) || (declaration && typeof declaration === 'object' &&
      Object.keys(declaration).every(key => key === 'argv' || key === 'inputs')),
    'INVALID_EXECUTABLE_CHECK: expected argv or {argv, inputs}');
    const { argv, inputs = [] } = Array.isArray(declaration) ? { argv: declaration } : declaration ?? {};
    assert(Array.isArray(argv) && argv.length > 0 &&
      argv.every(arg => typeof arg === 'string' && !arg.includes('\0')) && argv[0].trim(),
    'INVALID_EXECUTABLE_CHECK: expected nonempty command argv');
    assert(Array.isArray(inputs), violation('inputs must be an array'));
    return { argv, inputs: inputs.map(input => {
      assert(input && typeof input.path === 'string' && input.path && !input.path.includes('\0'),
        violation('each input needs a path'));
      assert(Object.keys(input).every(key => key === 'path' || key === 'ref'), violation('unknown input field'));
      return { ...input, ...(input.ref === 'HEAD' ? { ref } : {}) };
    }) };
  });
  return { ref, checks };
}

// Include symlink aliases beneath a directory scope: src/link -> checks grants
// implementation a write route to checks even if checks is lexically outside src.
function writablePaths(scopes) {
  const paths = [];
  const visited = new Set();
  function visit(path) {
    paths.push(resolve(path));
    let target;
    try { target = realpathSync(path); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
      throw error;
    }
    paths.push(target);
    if (visited.has(target)) return;
    visited.add(target);
    if (lstatSync(target).isDirectory()) {
      for (const entry of readdirSync(target)) visit(join(target, entry));
    }
  }
  for (const scope of scopes) visit(scope);
  return paths;
}

function validateInput(input, writable) {
  if (input.ref !== undefined) {
    assert(/^[a-f0-9]{40}$/.test(input.ref), violation(`missing pinned Git ref for ${input.path}`));
    assert(!isAbsolute(input.path) && input.path.split('/').every(part => part && part !== '.' && part !== '..'),
      violation(`Git input must be a repository-relative path: ${input.path}`));
    try {
      assert.equal(git('cat-file', '-t', input.ref).toString().trim(), 'commit');
      // Do not materialize a symlink blob as executable source.
      const mode = git('ls-tree', input.ref, '--', input.path).toString().split(' ')[0];
      assert(mode === '100644' || mode === '100755');
      return git('show', `${input.ref}:${input.path}`);
    } catch (cause) {
      throw new Error(violation(`pinned Git input unavailable: ${input.ref}:${input.path}`), { cause });
    }
  }
  assert(isAbsolute(input.path), violation(`missing pinned Git ref for ${input.path}; external inputs require absolute paths`));
  let target;
  try { target = realpathSync(input.path); }
  catch (cause) { throw new Error(violation(`external input unavailable: ${input.path}`), { cause }); }
  const stat = lstatSync(target);
  assert(stat.isFile(), violation(`external input must be a file: ${input.path}`));
  assert(stat.nlink === 1, violation(`external input has writable hard-link aliases: ${input.path}`));
  assert(!writable.some(scope => within(resolve(input.path), scope) || within(target, scope)),
    violation(`acceptance input is implementation-writable: ${input.path}`));
  return null;
}

export function validateAcceptance(pkg) {
  const contract = pkg.verification;
  assert(contract && /^[a-f0-9]{40}$/.test(contract.ref) && contract.ref === pkg.head,
    violation('missing or changed verification pinned Git ref'));
  assert(contract.checks?.length > 0, 'MISSING_EXECUTABLE_CHECKS');
  assert.deepEqual(contract.checks.map(check => check.argv), pkg.verificationCommands,
    violation('argv does not match the verification contract'));
  const writable = writablePaths(pkg.filesInScope);
  return contract.checks.map(check => {
    const paths = new Set();
    const sources = check.inputs.map(input => {
      assert(!paths.has(input.path), violation(`duplicate acceptance input: ${input.path}`));
      paths.add(input.path);
      return validateInput(input, writable);
    });
    const argv = check.argv;
    // Legacy inline Node assertions are themselves code pinned in the backlog.
    // Runtime options that could preload checkout code are deliberately excluded.
    const node = argv[0] === 'node' || argv[0] === process.execPath;
    const inline = node && ((argv[1] === '-e' && argv.length === 3) ||
      (argv[1] === '--input-type=module' && argv[2] === '-e' && argv.length === 4));
    const script = node ? argv[1] : argv[0];
    if (!inline) {
      assert(script && !script.startsWith('-'), violation(`unsupported acceptance invocation: ${JSON.stringify(argv)}`));
      const input = check.inputs.find(input => input.path === script);
      if (!input) {
        assert(!writable.some(scope => within(resolve(script), scope)),
          violation(`acceptance script is implementation-writable: ${script}`));
        throw new Error(violation(`undeclared acceptance script: ${script}; declare a pinned Git input or external absolute path`));
      }
      if (!node) {
        const source = sources[check.inputs.indexOf(input)] ?? readFileSync(input.path);
        assert(source.subarray(0, 2).toString() === '#!',
          violation(`declare an acceptance script with a shebang, not a runtime executable: ${script}`));
      }
    }
    return { ...check, sources, node };
  });
}

export function runAcceptance(pkg) {
  // Validate every input before executing any command, including later checks.
  const checks = validateAcceptance(pkg);
  for (const check of checks) {
    const directory = mkdtempSync(join(tmpdir(), 'drive-acceptance-'));
    try {
      const replacements = new Map();
      check.inputs.forEach((input, index) => {
        if (check.sources[index] === null) return;
        const path = join(directory, input.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, check.sources[index], { flag: 'wx', mode: 0o600 });
        if (check.argv[0] === input.path) chmodSync(path, 0o700);
        replacements.set(input.path, path);
      });
      const argv = check.argv.map(arg => replacements.get(arg) ?? arg);
      if (check.node) argv[0] = process.execPath;
      console.log(`CHECK ${JSON.stringify(check.argv)}`);
      // Do not let ambient Node preload or search-path settings add mutable code.
      const env = { ...process.env };
      delete env.NODE_OPTIONS;
      delete env.NODE_PATH;
      const result = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', timeout: 120000, env });
      assert(!result.error && result.status === 0,
        `PACKAGE_CHECK_FAILED: ${JSON.stringify(check.argv)} (${result.error?.message ?? result.signal ?? result.status}); DoD: ${pkg.definitionOfDone.join('; ')}`);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
}
