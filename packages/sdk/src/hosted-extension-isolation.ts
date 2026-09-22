import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { canonicalize } from './canonical.js';
import { validateFlowExtensionManifest, type FlowExtensionManifest } from './flow-extension-manifest.js';
import { assertCompatible, runtimeVersions } from './flow-extension-compat.js';
import {
  hostedExtensionDispatchIdentity,
  type HostedExtensionDispatch,
} from './flow-extension-loader.js';
import { PluginError } from './plugin-manifest.js';
import { findPluginProject } from './plugin-loader.js';
import { reconcileDeclaredExtensions } from './plugin-lock.js';
import { pluginStoreDirectory, verifyStoredPlugin } from './plugin-store.js';
import { HOSTED_EXTENSION_SANDBOX_SOURCE } from './hosted-extension-sandbox-source.js';

const HOSTED_WRITE = 'cloud:babysitter-turn';
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const BABYSITTER_REF = /^github:AgentWorkforce\/flows@[a-f0-9]{40}#extensions\/babysitter$/;
const DELIVERY_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const RECEIPT_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const HEAD_SHA = /^[a-f0-9]{40}$/;
const NATIVE_TRIGGERS = [
  { provider: 'github', event: 'pull_request', actions: ['opened', 'synchronize', 'reopened', 'ready_for_review', 'closed', 'labeled', 'unlabeled'] },
  { provider: 'github', event: 'pull_request_review', actions: ['submitted', 'dismissed'] },
  { provider: 'github', event: 'check_run', actions: ['completed'] },
  { provider: 'github', event: 'issue_comment', actions: ['created'] },
];

export interface HostedExtensionArtifact {
  readonly ref: string;
  readonly name: string;
  readonly version: string;
  readonly directory: string;
  readonly digest: string;
  readonly manifestSha256: string;
}

export interface HostedCapabilityAuthority {
  readonly dispatch: HostedExtensionDispatch;
  readonly extension: Readonly<{
    name: string;
    version: string;
    ref: string;
    digest: string;
  }>;
}

export interface HostedBabysitterCapability {
  queue(request: unknown, authority: HostedCapabilityAuthority): Promise<unknown>;
}

export interface RunHostedExtensionOptions {
  readonly artifact: HostedExtensionArtifact;
  readonly dispatch: HostedExtensionDispatch;
  /** Host-normalized delivery descriptor. Its event identity must equal dispatch. */
  readonly input: unknown;
  readonly babysitterTurn: HostedBabysitterCapability;
  readonly timeoutMs?: number;
  /** Test/packaging override. Production resolves /usr/bin/bwrap. */
  readonly bubblewrapPath?: string;
  /** Test/packaging override. Defaults to the current, fingerprinted Node executable. */
  readonly nodePath?: string;
}

export interface HostedExtensionResult {
  readonly completionReason: 'success';
  readonly capabilityCalls: 1;
}

/**
 * Resolve installed extension artifacts without importing their JavaScript.
 * Hosted callers pair this with `loadAuthoredFlow(..., { extensions: 'none' })`;
 * using the ordinary compose loader would execute extension top-level code in
 * the host before the sandbox exists.
 */
export async function loadHostedExtensionArtifacts(
  flowPath: string,
): Promise<readonly HostedExtensionArtifact[]> {
  const root = findPluginProject(dirname(resolve(flowPath)));
  if (root === undefined) return Object.freeze([]);
  const artifacts: HostedExtensionArtifact[] = [];
  for (const { ref, entry } of reconcileDeclaredExtensions(root)) {
    const directory = pluginStoreDirectory(root, entry.name, entry.digest);
    await verifyStoredPlugin(directory, entry.digest);
    artifacts.push(Object.freeze({
      ref,
      name: entry.name,
      version: entry.version,
      directory,
      digest: entry.digest,
      manifestSha256: entry.manifestSha256,
    }));
  }
  return Object.freeze(artifacts);
}

/**
 * Execute a capability-only hosted extension in a Linux mount/PID/network/user
 * namespace. The extension is first imported inside that namespace. It sees
 * no host workspace, environment credentials, network, child process, MCP,
 * helpers, harnesses, or base-flow context. The parent exposes exactly one
 * authenticated capability adapter and passes the original branded dispatch
 * authority to that adapter out of band.
 *
 * This is deliberately not wired into executeAuthoredFlow yet. #549's refusal
 * remains the rollout gate until the Cloud adapter and independent review land.
 */
export async function runHostedCapabilityExtension(
  options: RunHostedExtensionOptions,
): Promise<HostedExtensionResult> {
  if (process.platform !== 'linux') return unsupported('hosted extension isolation requires Linux');
  const bwrap = executable(options.bubblewrapPath ?? '/usr/bin/bwrap', 'bubblewrap');
  const node = executable(options.nodePath ?? process.execPath, 'Node');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    return unsupported('hosted extension timeout must be an integer from 1 to 60000ms');
  }

  const manifest = await verifiedManifest(options.artifact);
  assertCapabilityOnlyManifest(manifest);
  const versions = runtimeVersions();
  assertCompatible(manifest, versions);
  const identity = hostedExtensionDispatchIdentity(options.dispatch);
  assertManifestRoutes(manifest, identity);
  const normalizedInput = babysitterInput(options.input, options.dispatch);
  const entryPath = resolve(options.artifact.directory, manifest.entry);
  if (!entryPath.startsWith(`${resolve(options.artifact.directory)}/`)) {
    throw new PluginError('plugin_path_invalid', `${manifest.entry}: hosted extension entry escapes its artifact.`);
  }
  const surfaceRoot = resolveSurfaceRoot(versions.surface);

  const runtimeDirectory = await mkdtemp(join(tmpdir(), 'flows-hosted-extension-'));
  const runner = join(runtimeDirectory, 'runner.mjs');
  const surfaceFacade = join(runtimeDirectory, 'surface');
  try {
    await writeFile(runner, HOSTED_EXTENSION_SANDBOX_SOURCE, { mode: 0o400, flag: 'wx' });
    await writeSurfaceFacade(surfaceFacade);
    const args = sandboxArguments({
      node, runner, extension: realpathSync(options.artifact.directory), surfaceFacade, surfaceRoot,
    });
    const child = spawn(bwrap, args, {
      cwd: '/', env: {},
      stdio: ['pipe', 'ignore', 'pipe', 'pipe'],
    });
    const protocol = child.stdio[3] as Readable;
    const stdin = child.stdin as Writable;
    const stderr = child.stderr as Readable;
    const authority: HostedCapabilityAuthority = Object.freeze({
      dispatch: options.dispatch,
      extension: Object.freeze({
        name: manifest.name,
        version: manifest.version,
        ref: options.artifact.ref,
        digest: options.artifact.digest,
      }),
    });
    return await exchange(child, protocol, stdin, stderr, timeoutMs, {
      type: 'execute',
      entry: `/extension/src/${manifest.entry}`,
      surfaceRuntime: '/extension/node_modules/@relayflows/surface/runtime.js',
      capability: HOSTED_WRITE,
      identity,
      input: normalizedInput,
    }, async request => babysitterReceipt(await options.babysitterTurn.queue(
      babysitterRequest(request, normalizedInput, options.dispatch),
      authority,
    )));
  } finally {
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
}

async function verifiedManifest(artifact: HostedExtensionArtifact): Promise<FlowExtensionManifest> {
  if (!BABYSITTER_REF.test(artifact.ref)) {
    throw new PluginError('plugin_source_invalid', `${artifact.ref}: hosted capability isolation accepts only the immutable native Babysitter source.`);
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.digest) || !/^[a-f0-9]{64}$/.test(artifact.manifestSha256)) {
    throw new PluginError('plugin_source_drift', `${artifact.ref}: hosted extension digests are malformed.`);
  }
  await verifyStoredPlugin(artifact.directory, artifact.digest);
  const payload = JSON.parse((await readFile(join(artifact.directory, 'manifest.json'))).toString('utf8')) as Array<{ path?: unknown }>;
  if (payload.some(file => typeof file.path === 'string' && (file.path === 'node_modules' || file.path.startsWith('node_modules/')))) {
    throw new PluginError('plugin_source_drift', `${artifact.ref}: hosted extensions cannot carry node_modules.`);
  }
  const bytes = await readFile(join(artifact.directory, 'flows-plugin.json'));
  if (sha256(bytes) !== artifact.manifestSha256) {
    throw new PluginError('plugin_source_drift', `${artifact.ref}: flows-plugin.json differs from the lockfile's manifest hash.`);
  }
  let input: unknown;
  try { input = JSON.parse(bytes.toString('utf8')); }
  catch { throw new PluginError('plugin_manifest_invalid', `${artifact.ref}: flows-plugin.json is not valid JSON.`); }
  const manifest = validateFlowExtensionManifest(input);
  if (manifest.name !== artifact.name || manifest.version !== artifact.version) {
    throw new PluginError(
      'plugin_source_drift',
      `${artifact.ref}: manifest names ${manifest.name}@${manifest.version}, lockfile has ${artifact.name}@${artifact.version}.`,
    );
  }
  return manifest;
}

function assertCapabilityOnlyManifest(manifest: FlowExtensionManifest): void {
  const expected = {
    integrations: ['github'], harnesses: ['codex'], mcp: [], writes: [HOSTED_WRITE],
    base: [{ name: 'software-factory', version: '*' }],
    budget: { dollars: 1, wallclock: '5m' },
    triggers: NATIVE_TRIGGERS,
  };
  const actual = {
    integrations: manifest.permissions.integrations,
    harnesses: manifest.permissions.harnesses,
    mcp: manifest.permissions.mcp,
    writes: manifest.permissions.writes,
    base: manifest.compat.base,
    budget: manifest.permissions.budget,
    triggers: manifest.triggers,
  };
  if (canonicalize(actual) !== canonicalize(expected)
    || manifest.name !== 'babysitter'
    || manifest.entry !== 'babysitter.flow.ts'
    || !manifest.extends.handlers || manifest.extends.hooks.length !== 0
    || manifest.preflight.credentials.length !== 0 || manifest.preflight.servers.length !== 0) {
    throw new PluginError(
      'plugin_unsupported',
      `${manifest.name}: hosted capability isolation accepts only the native Babysitter permission profile.`,
    );
  }
}

function assertManifestRoutes(
  manifest: FlowExtensionManifest,
  identity: { readonly provider: string; readonly event: string; readonly action?: string },
): void {
  const matches = manifest.triggers.filter(trigger => trigger.provider === identity.provider
    && trigger.event === identity.event
    && (trigger.actions.length === 0 ? identity.action === undefined : identity.action !== undefined && trigger.actions.includes(identity.action)));
  if (matches.length !== 1) {
    throw new PluginError('plugin_event_unroutable', `${manifest.name}: hosted event is not declared exactly once.`);
  }
}

function babysitterInput(input: unknown, dispatch: HostedExtensionDispatch): unknown {
  const top = exactRecord(input, 'Hosted extension input', ['event', 'pullRequest']);
  const event = exactRecord(top.event, 'Hosted extension event', ['provider', 'eventType', 'deliveryId']);
  const pullRequest = optionalRecord(
    top.pullRequest,
    'Hosted extension pull request',
    ['host', 'owner', 'repo', 'number', 'headSha'],
    ['owner', 'repo', 'number'],
  );
  if (event.provider !== dispatch.provider || event.eventType !== dispatch.eventType
    || event.deliveryId !== dispatch.deliveryId || event.provider !== 'github'
    || !DELIVERY_ID.test(String(event.deliveryId))
    || (pullRequest.host !== undefined && pullRequest.host !== 'github')
    || typeof pullRequest.owner !== 'string' || !OWNER.test(pullRequest.owner)
    || typeof pullRequest.repo !== 'string' || !REPOSITORY.test(pullRequest.repo)
    || pullRequest.repo === '.' || pullRequest.repo === '..'
    || typeof pullRequest.number !== 'number' || !Number.isSafeInteger(pullRequest.number) || pullRequest.number <= 0
    || (pullRequest.headSha !== undefined
      && (typeof pullRequest.headSha !== 'string' || !HEAD_SHA.test(pullRequest.headSha)))) {
    throw new PluginError('plugin_event_unroutable', 'Hosted extension input does not match the verified GitHub delivery.');
  }
  return jsonSnapshot(input, 'hosted extension input');
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

function babysitterRequest(value: unknown, input: unknown, dispatch: HostedExtensionDispatch): unknown {
  const request = exactRecord(value, 'Babysitter capability request', ['delivery']);
  const delivery = exactRecord(request.delivery, 'Babysitter delivery', ['deliveryId', 'provider', 'eventType', 'pullRequest']);
  const pullRequest = exactRecord(delivery.pullRequest, 'Babysitter pull request', ['owner', 'repository', 'number']);
  const normalized = exactRecord(input, 'Hosted extension input', ['event', 'pullRequest']);
  const inputPullRequest = record(normalized.pullRequest, 'Hosted extension pull request');
  if (delivery.deliveryId !== dispatch.deliveryId || !DELIVERY_ID.test(String(delivery.deliveryId))
    || delivery.provider !== 'github' || delivery.eventType !== dispatch.eventType
    || typeof pullRequest.owner !== 'string' || !OWNER.test(pullRequest.owner)
    || typeof pullRequest.repository !== 'string' || !REPOSITORY.test(pullRequest.repository)
    || pullRequest.repository === '.' || pullRequest.repository === '..'
    || typeof pullRequest.number !== 'number' || !Number.isSafeInteger(pullRequest.number) || pullRequest.number <= 0
    || pullRequest.owner !== inputPullRequest.owner
    || pullRequest.repository !== inputPullRequest.repo
    || pullRequest.number !== inputPullRequest.number) {
    throw new PluginError('plugin_event_unroutable', 'Babysitter capability request does not match verified delivery input.');
  }
  return jsonSnapshot(value, 'Babysitter capability request');
}

function babysitterReceipt(value: unknown): unknown {
  const receipt = exactRecord(value, 'Babysitter capability receipt', ['receiptId', 'status']);
  if (typeof receipt.receiptId !== 'string' || !RECEIPT_ID.test(receipt.receiptId)
    || (receipt.status !== 'queued' && receipt.status !== 'duplicate')) {
    throw new PluginError('plugin_unsupported', 'Babysitter capability returned an invalid receipt.');
  }
  return Object.freeze({ receiptId: receipt.receiptId, status: receipt.status });
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PluginError('plugin_event_unroutable', `${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactRecord(value: unknown, what: string, keys: readonly string[]): Record<string, unknown> {
  const object = record(value, what);
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new PluginError('plugin_event_unroutable', `${what} must contain exactly ${keys.join(', ')}.`);
  }
  return object;
}

function optionalRecord(
  value: unknown,
  what: string,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  const object = record(value, what);
  const extra = Object.keys(object).filter(key => !allowed.includes(key));
  const missing = required.filter(key => !Object.hasOwn(object, key));
  if (extra.length > 0 || missing.length > 0) {
    throw new PluginError('plugin_event_unroutable', `${what} has an invalid field set.`);
  }
  return object;
}

async function writeSurfaceFacade(directory: string): Promise<void> {
  await mkdir(directory);
  await Promise.all([
    writeFile(join(directory, 'package.json'), JSON.stringify({
      name: '@relayflows/surface',
      type: 'module',
      exports: { '.': './index.js', './runtime': './runtime.js' },
    }), { mode: 0o400, flag: 'wx' }),
    writeFile(
      join(directory, 'index.js'),
      "export { flow } from './dist/flow.js';\nexport { github } from './dist/triggers/github.js';\n",
      { mode: 0o400, flag: 'wx' },
    ),
    writeFile(
      join(directory, 'runtime.js'),
      "export { getFlowDefinition } from './dist/flow.js';\n",
      { mode: 0o400, flag: 'wx' },
    ),
  ]);
}

function sandboxArguments(input: {
  node: string;
  runner: string;
  extension: string;
  surfaceFacade: string;
  surfaceRoot: string;
}): string[] {
  const args = [
    '--unshare-all', '--die-with-parent', '--new-session', '--clearenv', '--cap-drop', 'ALL',
    '--dir', '/usr',
  ];
  // Bind only dynamic-library roots, not all of /usr (which commonly includes
  // compilers, shells, package managers, and occasionally source worktrees).
  for (const path of ['/usr/lib', '/usr/lib64', '/lib', '/lib64']) {
    if (!existsSync(path)) continue;
    args.push('--ro-bind', realpathSync(path), path);
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
    '--ro-bind', input.extension, '/extension/src',
    '--chdir', '/extension/src',
    '--setenv', 'HOME', '/tmp', '--setenv', 'TMPDIR', '/tmp', '--setenv', 'PATH', '/runtime',
    '/runtime/node', '--permission', '--experimental-strip-types', '--max-old-space-size=64',
    '--allow-fs-read=/runtime', '--allow-fs-read=/extension', '/runtime/runner.mjs',
  );
  return args;
}

function surfaceRuntimeMounts(surfaceRoot: string): string[] {
  const files = [
    'flow.js',
    'helpers/providers.js',
    'provider-trigger.js',
    'schedule.js',
    'triggers.js',
    'triggers/github.js',
  ];
  return files.flatMap(file => {
    const source = realpathSync(join(surfaceRoot, 'dist', file));
    return ['--ro-bind', source, `/extension/node_modules/@relayflows/surface/dist/${file}`];
  });
}

function executable(path: string, name: string): string {
  let real: string;
  try { real = realpathSync(path); }
  catch { return unsupported(`${name} is unavailable`); }
  if (!lstatSync(real).isFile()) return unsupported(`${name} is not a regular file`);
  return real;
}

async function exchange(
  child: ReturnType<typeof spawn>,
  protocol: Readable,
  stdin: Writable,
  stderr: Readable,
  timeoutMs: number,
  request: unknown,
  invoke: (request: unknown) => Promise<unknown>,
): Promise<HostedExtensionResult> {
  let buffer = '';
  let stderrText = '';
  let calls = 0;
  stderr.setEncoding('utf8');
  stderr.on('data', chunk => { stderrText = (stderrText + String(chunk)).slice(-MAX_STDERR_BYTES); });
  protocol.setEncoding('utf8');
  const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  timeout.unref();
  return await new Promise<HostedExtensionResult>((resolvePromise, rejectPromise) => {
    let settled = false;
    let capabilityState: 'none' | 'pending' | 'completed' | 'failed' = 'none';
    const finish = (error?: Error, result?: HostedExtensionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (error !== undefined) rejectPromise(error);
      else resolvePromise(result!);
    };
    const refuse = (message: string) => {
      child.kill('SIGKILL');
      finish(new PluginError('plugin_unsupported', message));
    };
    stdin.on('error', () => finish(new PluginError('plugin_unsupported', 'Hosted extension capability channel closed.')));
    protocol.on('error', () => finish(new PluginError('plugin_unsupported', 'Hosted extension protocol channel failed.')));
    protocol.on('data', chunk => {
      buffer += String(chunk);
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) return refuse('Hosted extension protocol exceeded its size limit.');
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message: Record<string, unknown>;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return refuse('Hosted extension emitted a non-object protocol frame.');
          }
          message = parsed as Record<string, unknown>;
        }
        catch { return refuse('Hosted extension emitted malformed protocol data.'); }
        if (message.type === 'capability') {
          if (!hasExactKeys(message, ['type', 'id', 'name', 'request'])) {
            return refuse('Hosted extension emitted a malformed capability frame.');
          }
          calls += 1;
          if (calls !== 1 || capabilityState !== 'none' || message.name !== HOSTED_WRITE || message.id !== 1) {
            return refuse('Hosted extension requested an undeclared or repeated capability.');
          }
          capabilityState = 'pending';
          void invoke(message.request).then(
            value => {
              if (settled) return;
              try {
                const snapshot = jsonSnapshot(value, 'hosted capability result');
                capabilityState = 'completed';
                stdin.write(`${JSON.stringify({ type: 'capability-result', id: 1, ok: true, value: snapshot })}\n`);
              } catch (error) {
                capabilityState = 'failed';
                stdin.write(`${JSON.stringify({ type: 'capability-result', id: 1, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
              }
            },
            error => {
              if (settled) return;
              capabilityState = 'failed';
              stdin.write(`${JSON.stringify({ type: 'capability-result', id: 1, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
            },
          );
        } else if (message.type === 'result') {
          if (!hasExactKeys(message, ['type', 'completionReason', 'capabilityCalls'])
            || calls !== 1 || capabilityState !== 'completed'
            || message.completionReason !== 'success' || message.capabilityCalls !== 1) {
            return refuse('Hosted extension reported a completion without exactly one capability call.');
          }
          finish(undefined, Object.freeze({ completionReason: 'success', capabilityCalls: 1 }));
        } else if (message.type === 'error') {
          if (!hasExactKeys(message, ['type', 'message']) || typeof message.message !== 'string') {
            return refuse('Hosted extension emitted a malformed error frame.');
          }
          finish(new PluginError('plugin_unsupported', `Hosted extension failed: ${String(message.message).slice(0, 8192)}`));
        } else return refuse('Hosted extension emitted an unknown protocol message.');
      }
    });
    child.once('error', () => finish(new PluginError('plugin_unsupported', 'Hosted extension sandbox could not start.')));
    child.once('close', code => {
      if (!settled) finish(new PluginError(
        'plugin_unsupported',
        `Hosted extension sandbox exited without a valid completion (exit ${code ?? 'signal'})${stderrText === '' ? '' : `: ${stderrText}`}`,
      ));
    });
    stdin.write(`${JSON.stringify(request)}\n`);
  });
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function jsonSnapshot(value: unknown, what: string): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_FRAME_BYTES) {
    throw new PluginError('plugin_unsupported', `${what} is not bounded JSON data.`);
  }
  return JSON.parse(encoded) as unknown;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function unsupported(message: string): never {
  throw new PluginError('plugin_unsupported', message);
}
