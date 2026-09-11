import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalize } from './canonical.js';
import { compileSpec } from './compile.js';
import type { BundleFile } from './bundle.js';

/** Bun is an explicit build dependency, never an implicit install. */
function bun(args: string[], cwd: string): string {
  const result = spawnSync('bun', ['--no-env-file', ...args], {
    cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    env: { PATH: process.env['PATH'], NODE_ENV: 'production', TZ: 'UTC' },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`TypeScript build requires Bun: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout.trim();
}

export async function buildTypescript(input: string) {
  const directory = dirname(input);
  const lockPath = await findLock(directory);
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages) {
    throw new Error('package-lock.json: expected npm lockfile version 2 or 3 with pinned packages');
  }
  await checkInstalledVersions(dirname(lockPath), lock.packages);
  const compiler = `bun@${bun(['--version'], directory)}`;
  const staging = await mkdtemp(join(tmpdir(), 'flows-ts-'));
  try {
    // Evaluate module declarations, never the authored body. Resolve the runtime
    // beside the input, keeping flow()'s WeakMap identity in the same module.
    const probe = `
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const module = await import(${JSON.stringify(pathToFileURL(input).href)});
let spec = module.default;
let authored = false;
if (!spec || !Array.isArray(spec.steps)) {
  const require = createRequire(${JSON.stringify(pathToFileURL(input).href)});
  const { getFlowDefinition } = await import(pathToFileURL(require.resolve('@relayflows/surface/runtime')).href);
  const definition = getFlowDefinition(spec);
  if (Object.keys(definition.header).length) throw new Error('unsupported authored flow header');
  if (!module.spec) throw new Error('authored flow() requires an exported spec declaration for build-time preflight; the body is not executed during build');
  spec = module.spec;
  if (spec.name !== definition.name) throw new Error('exported spec name must match flow() name');
  authored = true;
}

process.stdout.write(JSON.stringify({ spec, authored }));
`;
    const probePath = join(staging, 'inspect.ts');
    await writeFile(probePath, probe);
    const inspected = JSON.parse(bun([probePath], directory));
    const spec = compileSpec(inspected.spec);
    const executable = join(staging, 'flow');
    bun(['build', '--compile', '--env=disable', '--no-compile-autoload-dotenv',
      '--no-compile-autoload-bunfig', '--outfile', executable, input], directory);
    const files: BundleFile[] = [
      { path: 'flow', data: await readFile(executable) },
      { path: 'lockfile.json', data: canonicalize(lock) },
    ];
    return { spec, authored: inspected.authored === true, compiler, files };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

/** Do not label a stale node_modules tree with a newer lockfile's pins. */
async function checkInstalledVersions(root: string, packages: Record<string, {
  version?: string; optional?: boolean; dev?: boolean; link?: boolean; resolved?: string;
}>): Promise<void> {
  for (const [path, entry] of Object.entries(packages)) {
    if (path === '') continue;
    if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')
      || (entry.resolved !== undefined && /^(?:file:|\/|[A-Za-z]:)/.test(entry.resolved))) {
      throw new Error(`package-lock.json: ${path} must use portable, pinned dependency locations`);
    }
    if (entry.link) continue; // Workspace source is captured by the compiler.
    let installed;
    try { installed = JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && (entry.optional || entry.dev)) continue;
      throw new Error(`package-lock.json: ${path} is missing; run npm ci before building`);
    }
    if (typeof entry.version !== 'string' || installed.version !== entry.version) {
      throw new Error(`package-lock.json: ${path} does not match its pinned version; run npm ci before building`);
    }
  }
}
async function findLock(start: string): Promise<string> {
  for (let directory = start; ; directory = dirname(directory)) {
    const candidate = join(directory, 'package-lock.json');
    try { await readFile(candidate); return candidate; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (dirname(directory) === directory) throw new Error('package-lock.json: no workspace lockfile found for TS flow');
  }
}
