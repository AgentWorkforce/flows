import { createRequire } from 'node:module';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { PluginError } from './plugin-manifest.js';
import { HOSTED_EXTENSION_SANDBOX_SOURCE } from './hosted-extension-sandbox-source.js';
import {
  exchangeHostedExtension,
  type HostedExtensionProtocolResult,
} from './hosted-extension-protocol.js';
import { materializePlugin, readStoredPluginFiles } from './plugin-store.js';

const HOSTED_WRITE = 'cloud:babysitter-turn';
const DEFAULT_TIMEOUT_MS = 10_000;

export interface RunHostedExtensionSandboxOptions {
  readonly artifactDirectory: string;
  readonly artifactDigest: string;
  readonly entry: string;
  readonly surfaceVersion: string;
  readonly identity: { readonly provider: string; readonly event: string; readonly action?: string };
  readonly input: unknown;
  readonly invoke: (request: unknown) => Promise<unknown>;
  readonly timeoutMs?: number;
  readonly bubblewrapPath?: string;
  readonly nodePath?: string;
}

export async function runHostedExtensionSandbox(
  options: RunHostedExtensionSandboxOptions,
): Promise<HostedExtensionProtocolResult> {
  if (process.platform !== 'linux') return unsupported('hosted extension isolation requires Linux');
  if (options.nodePath === undefined && !supportsHostedSandboxFlags(process.versions.node)) {
    return unsupported(`hosted extension isolation does not support Node ${process.versions.node}`);
  }
  const bwrap = executable(options.bubblewrapPath ?? '/usr/bin/bwrap', 'bubblewrap');
  const node = executable(options.nodePath ?? process.execPath, 'Node');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    return unsupported('hosted extension timeout must be an integer from 1 to 60000ms');
  }
  const entryPath = resolve(options.artifactDirectory, options.entry);
  if (!entryPath.startsWith(`${resolve(options.artifactDirectory)}/`)) {
    throw new PluginError('plugin_path_invalid', `${options.entry}: hosted extension entry escapes its artifact.`);
  }
  const surfaceRoot = resolveSurfaceRoot(options.surfaceVersion);
  const runtimeDirectory = await mkdtemp(join(tmpdir(), 'flows-hosted-extension-'));
  const runner = join(runtimeDirectory, 'runner.mjs');
  const surfaceFacade = join(runtimeDirectory, 'surface');
  try {
    const storedFiles = await readStoredPluginFiles(options.artifactDirectory, options.artifactDigest);
    const snapshot = await materializePlugin(
      runtimeDirectory,
      'hosted-extension',
      storedFiles.filter(file => file.path !== 'manifest.json'),
    );
    if (snapshot.digest !== options.artifactDigest) {
      throw new PluginError(
        'plugin_source_drift',
        'Hosted extension changed while its isolated snapshot was created.',
      );
    }
    await writeFile(runner, HOSTED_EXTENSION_SANDBOX_SOURCE, { mode: 0o400, flag: 'wx' });
    await writeSurfaceFacade(surfaceFacade);
    const args = sandboxArguments({
      node,
      runner,
      extension: realpathSync(snapshot.directory),
      surfaceFacade,
      surfaceRoot,
    });
    const child = spawn(bwrap, args, { cwd: '/', env: {}, stdio: ['pipe', 'ignore', 'pipe', 'pipe'] });
    return await exchangeHostedExtension(
      child,
      child.stdio[3] as Readable,
      child.stdin as Writable,
      child.stderr as Readable,
      timeoutMs,
      {
        type: 'execute',
        entry: `/extension/src/${options.entry}`,
        surfaceRuntime: '/extension/node_modules/@relayflows/surface/runtime.js',
        capability: HOSTED_WRITE,
        identity: options.identity,
        input: options.input,
      },
      options.invoke,
    );
  } finally {
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
}

function resolveSurfaceRoot(expectedVersion: string): string {
  let resolved: string;
  try { resolved = realpathSync(createRequire(import.meta.url).resolve('@relayflows/surface')); }
  catch { return unsupported('hosted extension cannot resolve @relayflows/surface'); }
  let directory = dirname(resolved);
  const root = parse(directory).root;
  while (directory !== root) {
    const packageJson = join(directory, 'package.json');
    if (existsSync(packageJson)) {
      try {
        const manifest = JSON.parse(readFileSync(packageJson, 'utf8')) as { name?: unknown; version?: unknown };
        if (manifest.name === '@relayflows/surface' && manifest.version === expectedVersion) {
          return realpathSync(directory);
        }
      } catch { /* keep walking */ }
    }
    directory = dirname(directory);
  }
  return unsupported('hosted extension resolved an invalid @relayflows/surface package');
}

async function writeSurfaceFacade(directory: string): Promise<void> {
  await mkdir(directory);
  await Promise.all([
    writeFile(join(directory, 'package.json'), JSON.stringify({
      name: '@relayflows/surface', type: 'module', exports: { '.': './index.js', './runtime': './runtime.js' },
    }), { mode: 0o400, flag: 'wx' }),
    writeFile(join(directory, 'index.js'),
      "export { flow } from './dist/flow.js';\nexport { github } from './dist/triggers/github.js';\n",
      { mode: 0o400, flag: 'wx' }),
    writeFile(join(directory, 'runtime.js'), "export { getFlowDefinition } from './dist/flow.js';\n",
      { mode: 0o400, flag: 'wx' }),
  ]);
}

function sandboxArguments(input: {
  node: string; runner: string; extension: string; surfaceFacade: string; surfaceRoot: string;
}): string[] {
  const args = [
    '--unshare-all', '--die-with-parent', '--new-session', '--clearenv', '--cap-drop', 'ALL', '--dir', '/usr',
  ];
  for (const path of ['/usr/lib', '/usr/lib64', '/lib', '/lib64']) {
    if (existsSync(path)) args.push('--ro-bind', realpathSync(path), path);
  }
  args.push(
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--dir', '/runtime', '--ro-bind', input.node, '/runtime/node', '--ro-bind', input.runner, '/runtime/runner.mjs',
    '--dir', '/extension', '--dir', '/extension/node_modules', '--dir', '/extension/node_modules/@relayflows',
    '--dir', '/extension/node_modules/@relayflows/surface',
    '--ro-bind', join(input.surfaceFacade, 'package.json'), '/extension/node_modules/@relayflows/surface/package.json',
    '--ro-bind', join(input.surfaceFacade, 'index.js'), '/extension/node_modules/@relayflows/surface/index.js',
    '--ro-bind', join(input.surfaceFacade, 'runtime.js'), '/extension/node_modules/@relayflows/surface/runtime.js',
    '--dir', '/extension/node_modules/@relayflows/surface/dist',
    '--dir', '/extension/node_modules/@relayflows/surface/dist/helpers',
    '--dir', '/extension/node_modules/@relayflows/surface/dist/triggers',
    ...surfaceRuntimeMounts(input.surfaceRoot),
    '--ro-bind', input.extension, '/extension/src', '--chdir', '/extension/src',
    '--setenv', 'HOME', '/tmp', '--setenv', 'TMPDIR', '/tmp', '--setenv', 'PATH', '/runtime',
    '/runtime/node', '--permission', '--experimental-strip-types', '--max-old-space-size=64',
    '--allow-fs-read=/runtime', '--allow-fs-read=/extension', '/runtime/runner.mjs',
  );
  return args;
}

function surfaceRuntimeMounts(surfaceRoot: string): string[] {
  return [
    'flow.js', 'helpers/providers.js', 'provider-trigger.js', 'schedule.js', 'triggers.js', 'triggers/github.js',
  ].flatMap(file => [
    '--ro-bind', realpathSync(join(surfaceRoot, 'dist', file)),
    `/extension/node_modules/@relayflows/surface/dist/${file}`,
  ]);
}

function executable(path: string, name: string): string {
  let real: string;
  try { real = realpathSync(path); }
  catch { return unsupported(`${name} is unavailable`); }
  if (!lstatSync(real).isFile()) return unsupported(`${name} is not a regular file`);
  return real;
}

export function supportsHostedSandboxFlags(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major >= 24 || (major === 23 && minor >= 5) || (major === 22 && minor >= 13);
}

function unsupported(message: string): never {
  throw new PluginError('plugin_unsupported', message);
}
