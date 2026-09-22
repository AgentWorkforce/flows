import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalize } from './canonical.js';
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
import { verifyStoredPlugin } from './plugin-store.js';
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
const BABYSITTER_REF = 'github:AgentWorkforce/flows@d3ee3b55ae636518dd4ad562aca5bae9c99f1a05#extensions/babysitter';
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
  return await runVerifiedNativeExtensionSandbox({ ...options, artifact, manifest });
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
  const authority: HostedCapabilityAuthority = Object.freeze({
    dispatch: options.dispatch,
    extension: Object.freeze({
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
  for (const artifact of value.artifacts) {
    const manifest = await verifiedManifest(artifact);
    assertCompatible(manifest, versions);
    assertBaseCompatible(manifest, base);
    if (hostedManifestRoutes(manifest, identity)) matches.push({ artifact, manifest });
  }
  if (matches.length > 1) {
    throw new PluginError(
      'plugin_event_ambiguous',
      `Hosted event matches multiple extension manifests (${matches.map(match => match.manifest.name).join(', ')}).`,
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
  if (!/^[a-f0-9]{64}$/.test(artifact.digest) || !/^[a-f0-9]{64}$/.test(artifact.manifestSha256)) {
    throw new PluginError('plugin_source_drift', `${artifact.ref}: hosted extension digests are malformed.`);
  }
  await verifyStoredPlugin(artifact.directory, artifact.digest);
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

async function assertPinnedBabysitter(artifact: HostedExtensionArtifact): Promise<void> {
  if (artifact.ref !== BABYSITTER_REF || artifact.name !== 'babysitter' || artifact.version !== '0.2.0'
    || artifact.digest !== BABYSITTER_DIGEST || artifact.manifestSha256 !== BABYSITTER_MANIFEST_SHA256) {
    throw new PluginError(
      'plugin_source_invalid',
      'Hosted capability isolation accepts only the reviewed native Babysitter artifact.',
    );
  }
  const payload = JSON.parse(
    (await readFile(join(artifact.directory, 'manifest.json'))).toString('utf8'),
  ) as Array<{ path?: unknown }>;
  if (payload.some(file => typeof file.path === 'string'
    && (file.path === 'node_modules' || file.path.startsWith('node_modules/')))) {
    throw new PluginError('plugin_source_drift', `${artifact.ref}: hosted extensions cannot carry node_modules.`);
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
  return manifest.triggers.some(trigger => trigger.provider === identity.provider
    && trigger.event === identity.event
    && (trigger.actions.length === 0
      || (identity.action !== undefined && trigger.actions.includes(identity.action))));
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
  return boundedJsonSnapshot(input, 'hosted extension input');
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
  return boundedJsonSnapshot(value, 'Babysitter capability request');
}

function babysitterReceipt(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PluginError('plugin_unsupported', 'Babysitter capability returned an invalid receipt.');
  }
  const receipt = value as Record<string, unknown>;
  const keys = Object.keys(receipt).sort();
  if (keys.length !== 2 || keys[0] !== 'receiptId' || keys[1] !== 'status'
    || typeof receipt.receiptId !== 'string' || !RECEIPT_ID.test(receipt.receiptId)
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

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}
