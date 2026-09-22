import { canonicalize } from './canonical.js';
import { sha256 } from './bundle.js';
import { validateFlowExtensionManifest, type FlowExtensionManifest } from './flow-extension-manifest.js';
import { assertBaseCompatible, assertCompatible, runtimeVersions } from './flow-extension-compat.js';
import {
  hostedExtensionDispatchIdentity,
  type HostedExtensionDispatch,
} from './flow-extension-loader.js';
import {
  assertHostedInstallationAuthority,
  assertHostedRuntimeAuthority,
  type HostedExtensionArtifact,
  type HostedExtensionBase,
  type HostedExtensionInstallation,
} from './hosted-extension-runtime.js';
import { PluginError } from './plugin-manifest.js';
import { readStoredPluginFiles } from './plugin-store.js';
import {
  boundedJsonSnapshot,
  type HostedExtensionProtocolResult,
} from './hosted-extension-protocol.js';
import { runHostedExtensionSandbox } from './hosted-extension-sandbox.js';

export {
  loadHostedExtensionArtifacts,
  loadHostedExtensionBase,
  loadHostedExtensionRuntime,
} from './hosted-extension-runtime.js';
export type {
  HostedExtensionArtifact,
  HostedExtensionBase,
  HostedExtensionInstallation,
  HostedExtensionRuntime,
} from './hosted-extension-runtime.js';

const HOSTED_WRITE = 'cloud:babysitter-turn';
const ARRAY_IS_ARRAY = Array.isArray;
const JSON_PARSE = JSON.parse;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_KEYS = Object.keys;
const REGEXP_TEST = RegExp.prototype.test;
const STRING_STARTS_WITH = String.prototype.startsWith;
const BABYSITTER_REF = 'github:AgentWorkforce/flows@8b33ebab8347514f80d9da5a81206a087f641714#extensions/babysitter';
const BABYSITTER_DIGEST = 'bdf2187b9a242667d34bbc63e7a744753e146dc8cd6f4047047f2aed28f406ee';
const BABYSITTER_MANIFEST_SHA256 = '5631a06bbdc8186f4ee0ff955610ead24d001c5197b59fb1fe81fe422c44f226';
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
  /** Complete, lock-ordered set returned by loadHostedExtensionRuntime. */
  readonly installation: HostedExtensionInstallation;
  /** Same-generation base returned by loadHostedExtensionRuntime. */
  readonly base: HostedExtensionBase;
  readonly dispatch: HostedExtensionDispatch;
  /** Host-normalized delivery descriptor. Its event identity must equal dispatch. */
  readonly input: unknown;
  readonly babysitterTurn: HostedBabysitterCapability;
  readonly timeoutMs?: number;
  /** Test/packaging override. Production resolves /usr/bin/bwrap. */
  readonly bubblewrapPath?: string;
  /** Test/packaging override. Defaults to the current, fingerprinted Node executable. */
  readonly nodePath?: string;
  /** Test/packaging override. Production resolves /usr/bin/prlimit. */
  readonly prlimitPath?: string;
}

export type HostedExtensionResult = HostedExtensionProtocolResult;

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
  const identity = hostedExtensionDispatchIdentity(options.dispatch);
  await assertHostedRuntimeAuthority(options.installation, options.base);
  const { artifact, manifest } = await selectHostedExtensionForRuntime(
    options.installation,
    options.base,
    identity,
    runtimeVersions(),
  );
  return await runVerifiedNativeExtensionSandbox({
    ...options,
    artifact,
    manifest,
    beforeLaunch: () => assertHostedRuntimeAuthority(options.installation, options.base),
  });
}

interface RunVerifiedNativeExtensionOptions {
  readonly artifact: HostedExtensionArtifact;
  readonly manifest: FlowExtensionManifest;
  readonly dispatch: HostedExtensionDispatch;
  readonly input: unknown;
  readonly babysitterTurn: HostedBabysitterCapability;
  readonly timeoutMs?: number;
  readonly bubblewrapPath?: string;
  readonly nodePath?: string;
  readonly prlimitPath?: string;
  readonly surfaceRoot?: string;
  readonly beforeLaunch?: () => Promise<void>;
}

/** @internal Security-harness seam; not exported from the SDK package root. */
export async function runVerifiedNativeExtensionSandbox(
  options: RunVerifiedNativeExtensionOptions,
): Promise<HostedExtensionResult> {
  assertCapabilityOnlyManifest(options.manifest);
  const identity = hostedExtensionDispatchIdentity(options.dispatch);
  assertManifestRoutes(options.manifest, identity);
  const normalizedInput = babysitterInput(options.input, options.dispatch);
  const versions = runtimeVersions();
  const authority: HostedCapabilityAuthority = OBJECT_FREEZE({
    dispatch: options.dispatch,
    extension: OBJECT_FREEZE({
      name: options.manifest.name,
      version: options.manifest.version,
      ref: options.artifact.ref,
      digest: options.artifact.digest,
    }),
  });
  return await runHostedExtensionSandbox({
    artifactDirectory: options.artifact.directory,
    artifactDigest: options.artifact.digest,
    entry: options.manifest.entry,
    surfaceVersion: versions.surface,
    identity,
    input: normalizedInput,
    timeoutMs: options.timeoutMs,
    bubblewrapPath: options.bubblewrapPath,
    nodePath: options.nodePath,
    prlimitPath: options.prlimitPath,
    surfaceRoot: options.surfaceRoot,
    beforeLaunch: options.beforeLaunch,
    invoke: async request => babysitterReceipt(await options.babysitterTurn.queue(
      babysitterRequest(request, normalizedInput, options.dispatch),
      authority,
    )),
  });
}

/** @internal Selection seam used by compatibility/security regression tests. */
export async function selectHostedExtensionForRuntime(
  value: HostedExtensionInstallation,
  base: HostedExtensionBase,
  identity: { readonly provider: string; readonly event: string; readonly action?: string },
  versions: Readonly<{ sdk: string; surface: string }>,
): Promise<{ artifact: HostedExtensionArtifact; manifest: FlowExtensionManifest }> {
  assertHostedInstallationAuthority(value);
  if (typeof base !== 'object' || base === null || typeof base.name !== 'string'
    || (base.version !== undefined && typeof base.version !== 'string')) {
    throw new PluginError('plugin_incompatible', 'Hosted base identity is malformed.');
  }
  const matches: Array<{ artifact: HostedExtensionArtifact; manifest: FlowExtensionManifest }> = [];
  for (let index = 0; index < value.artifacts.length; index += 1) {
    const artifact = value.artifacts[index]!;
    const manifest = await verifiedManifest(artifact);
    assertCompatible(manifest, versions);
    assertBaseCompatible(manifest, base);
    if (hostedManifestRoutes(manifest, identity)) matches[matches.length] = { artifact, manifest };
  }
  if (matches.length > 1) {
    throw new PluginError(
      'plugin_event_ambiguous',
      `Hosted event matches multiple extension manifests (${manifestNames(matches)}).`,
    );
  }
  const selected = matches[0];
  if (selected === undefined || selected.artifact.ref !== BABYSITTER_REF) {
    throw new PluginError('plugin_event_unroutable', 'Hosted event does not route to the pinned native Babysitter extension.');
  }
  await assertPinnedBabysitter(selected.artifact);
  assertCapabilityOnlyManifest(selected.manifest);
  return selected;
}

async function verifiedManifest(artifact: HostedExtensionArtifact): Promise<FlowExtensionManifest> {
  if (!matches(/^[a-f0-9]{64}$/, artifact.digest) || !matches(/^[a-f0-9]{64}$/, artifact.manifestSha256)) {
    throw new PluginError('plugin_source_drift', `${artifact.ref}: hosted extension digests are malformed.`);
  }
  const stored = await readStoredPluginFiles(artifact.directory, artifact.digest);
  let bytes: Buffer | undefined;
  for (let index = 0; index < stored.length; index += 1) {
    if (stored[index]!.path === 'flows-plugin.json') bytes = stored[index]!.data;
  }
  if (bytes === undefined) {
    throw new PluginError('plugin_source_drift', `${artifact.ref}: flows-plugin.json is missing.`);
  }
  if (sha256(bytes) !== artifact.manifestSha256) {
    throw new PluginError('plugin_source_drift', `${artifact.ref}: flows-plugin.json differs from the lockfile's manifest hash.`);
  }
  let input: unknown;
  try { input = JSON_PARSE(bytes.toString('utf8')); }
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

async function assertPinnedBabysitter(artifact: HostedExtensionArtifact): Promise<void> {
  if (artifact.ref !== BABYSITTER_REF || artifact.name !== 'babysitter' || artifact.version !== '0.2.0'
    || artifact.digest !== BABYSITTER_DIGEST || artifact.manifestSha256 !== BABYSITTER_MANIFEST_SHA256) {
    throw new PluginError(
      'plugin_source_invalid',
      'Hosted capability isolation accepts only the reviewed native Babysitter artifact.',
    );
  }
  const stored = await readStoredPluginFiles(artifact.directory, artifact.digest);
  for (let index = 0; index < stored.length; index += 1) {
    const path = stored[index]!.path;
    if (path === 'node_modules' || STRING_STARTS_WITH.call(path, 'node_modules/')) {
      throw new PluginError('plugin_source_drift', `${artifact.ref}: hosted extensions cannot carry node_modules.`);
    }
  }
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
  if (!hostedManifestRoutes(manifest, identity)) {
    throw new PluginError('plugin_event_unroutable', `${manifest.name}: hosted event is not declared exactly once.`);
  }
}

/** Generic handlers overlap action-specific deliveries, matching the SDK handler router. */
export function hostedManifestRoutes(
  manifest: Pick<FlowExtensionManifest, 'triggers'>,
  identity: { readonly provider: string; readonly event: string; readonly action?: string },
): boolean {
  for (let triggerIndex = 0; triggerIndex < manifest.triggers.length; triggerIndex += 1) {
    const trigger = manifest.triggers[triggerIndex]!;
    if (trigger.provider !== identity.provider || trigger.event !== identity.event) continue;
    if (trigger.actions.length === 0) return true;
    if (identity.action === undefined) continue;
    for (let actionIndex = 0; actionIndex < trigger.actions.length; actionIndex += 1) {
      if (trigger.actions[actionIndex] === identity.action) return true;
    }
  }
  return false;
}

function babysitterInput(input: unknown, dispatch: HostedExtensionDispatch): unknown {
  const snapshot = boundedJsonSnapshot(input, 'hosted extension input');
  const top = exactRecord(snapshot, 'Hosted extension input', ['event', 'pullRequest']);
  const event = exactRecord(top.event, 'Hosted extension event', ['provider', 'eventType', 'deliveryId']);
  const pullRequest = optionalRecord(
    top.pullRequest,
    'Hosted extension pull request',
    ['host', 'owner', 'repo', 'number', 'headSha'],
    ['owner', 'repo', 'number'],
  );
  if (event.provider !== dispatch.provider || event.eventType !== dispatch.eventType
    || event.deliveryId !== dispatch.deliveryId || event.provider !== 'github'
    || typeof event.deliveryId !== 'string' || !matches(DELIVERY_ID, event.deliveryId)
    || (pullRequest.host !== undefined && pullRequest.host !== 'github')
    || typeof pullRequest.owner !== 'string' || !matches(OWNER, pullRequest.owner)
    || typeof pullRequest.repo !== 'string' || !matches(REPOSITORY, pullRequest.repo)
    || pullRequest.repo === '.' || pullRequest.repo === '..'
    || typeof pullRequest.number !== 'number' || !NUMBER_IS_SAFE_INTEGER(pullRequest.number) || pullRequest.number <= 0
    || (pullRequest.headSha !== undefined
      && (typeof pullRequest.headSha !== 'string' || !matches(HEAD_SHA, pullRequest.headSha)))) {
    throw new PluginError('plugin_event_unroutable', 'Hosted extension input does not match the verified GitHub delivery.');
  }
  return snapshot;
}

function babysitterRequest(value: unknown, input: unknown, dispatch: HostedExtensionDispatch): unknown {
  const snapshot = boundedJsonSnapshot(value, 'Babysitter capability request');
  const request = exactRecord(snapshot, 'Babysitter capability request', ['delivery']);
  const delivery = exactRecord(request.delivery, 'Babysitter delivery', ['deliveryId', 'provider', 'eventType', 'pullRequest']);
  const pullRequest = exactRecord(delivery.pullRequest, 'Babysitter pull request', ['owner', 'repository', 'number']);
  const normalized = exactRecord(input, 'Hosted extension input', ['event', 'pullRequest']);
  const inputPullRequest = record(normalized.pullRequest, 'Hosted extension pull request');
  if (delivery.deliveryId !== dispatch.deliveryId
    || typeof delivery.deliveryId !== 'string' || !matches(DELIVERY_ID, delivery.deliveryId)
    || delivery.provider !== 'github' || delivery.eventType !== dispatch.eventType
    || typeof pullRequest.owner !== 'string' || !matches(OWNER, pullRequest.owner)
    || typeof pullRequest.repository !== 'string' || !matches(REPOSITORY, pullRequest.repository)
    || pullRequest.repository === '.' || pullRequest.repository === '..'
    || typeof pullRequest.number !== 'number' || !NUMBER_IS_SAFE_INTEGER(pullRequest.number) || pullRequest.number <= 0
    || pullRequest.owner !== inputPullRequest.owner
    || pullRequest.repository !== inputPullRequest.repo
    || pullRequest.number !== inputPullRequest.number) {
    throw new PluginError('plugin_event_unroutable', 'Babysitter capability request does not match verified delivery input.');
  }
  return snapshot;
}

function babysitterReceipt(value: unknown): unknown {
  const snapshot = boundedJsonSnapshot(value, 'Babysitter capability receipt');
  if (typeof snapshot !== 'object' || snapshot === null || ARRAY_IS_ARRAY(snapshot)) {
    throw new PluginError('plugin_unsupported', 'Babysitter capability returned an invalid receipt.');
  }
  const receipt = snapshot as Record<string, unknown>;
  if (!hasExactKeys(receipt, ['receiptId', 'status'])
    || typeof receipt.receiptId !== 'string' || !matches(RECEIPT_ID, receipt.receiptId)
    || (receipt.status !== 'queued' && receipt.status !== 'duplicate')) {
    throw new PluginError('plugin_unsupported', 'Babysitter capability returned an invalid receipt.');
  }
  return OBJECT_FREEZE({ receiptId: receipt.receiptId, status: receipt.status });
}

function matches(pattern: RegExp, value: string): boolean {
  return REGEXP_TEST.call(pattern, value);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || ARRAY_IS_ARRAY(value)) {
    throw new PluginError('plugin_event_unroutable', `${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactRecord(value: unknown, what: string, keys: readonly string[]): Record<string, unknown> {
  const object = record(value, what);
  if (!hasExactKeys(object, keys)) {
    throw new PluginError('plugin_event_unroutable', `${what} has an invalid field set.`);
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
  const actual = OBJECT_KEYS(object);
  for (let index = 0; index < actual.length; index += 1) {
    if (!contains(allowed, actual[index]!)) {
      throw new PluginError('plugin_event_unroutable', `${what} has an invalid field set.`);
    }
  }
  for (let index = 0; index < required.length; index += 1) {
    if (!OBJECT_HAS_OWN(object, required[index]!)) {
      throw new PluginError('plugin_event_unroutable', `${what} has an invalid field set.`);
    }
  }
  return object;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  if (OBJECT_KEYS(value).length !== keys.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    if (!OBJECT_HAS_OWN(value, keys[index]!)) return false;
  }
  return true;
}

function contains(values: readonly string[], expected: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === expected) return true;
  }
  return false;
}

function manifestNames(
  matches: readonly { readonly manifest: FlowExtensionManifest }[],
): string {
  let value = '';
  for (let index = 0; index < matches.length; index += 1) {
    value += `${index === 0 ? '' : ', '}${matches[index]!.manifest.name}`;
  }
  return value;
}
