import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import type { NodeResultInboxClient, NodeResultTerminalFailure } from './node-spawn-result.js';
import {
  LocalNodeSpawnPort,
  loadCoreBridge,
  type CallerDescriptor,
  type CoreBridgeApi,
  type CoreBridgeClient,
  type CoreInboxDelivery,
} from './node-spawn-local.js';
import { NodeSpawnError } from './node-spawn.js';
import { RemoteNodeSpawnPort, type RemoteNodeSpawnClient } from './node-spawn-remote.js';
import type { NodeSpawnPort } from './node-spawn.js';

export interface NodeSpawnPublisher { id: string; name: string }
export interface NodeSpawnRuntime {
  port: NodeSpawnPort;
  inbox: NodeResultInboxClient;
  publisher: NodeSpawnPublisher;
  baseUrl: string;
  node?: string;
  repo?: string;
  sandboxOnly?: boolean;
  /** Explicit authority family; Desktop alone may receive the worker's local run root. */
  authority?: 'desktop' | 'remote';
  /** Closes the publisher connection after every task using it has drained. */
  disconnect?(): Promise<void>;
}

export interface NodeSpawnRuntimeOwner {
  get(signal?: AbortSignal): Promise<NodeSpawnRuntime>;
  /** Returns only authority already established by configuration or a successful get(). */
  peek(): NodeSpawnRuntime | undefined;
  close(): Promise<void>;
}

/** Applies the same authority precedence for runtime creation and worker directory policy. */
export function mergeNodeSpawnEnvironment(
  environment: NodeJS.ProcessEnv | undefined,
  serviceCallerFile: string | undefined,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...inherited,
    ...environment,
    ...(serviceCallerFile === undefined
      ? {}
      : { RELAYFLOW_SERVICE_CALLER_FILE: serviceCallerFile }),
  };
}

/** Returns an exact nonempty Desktop capability path; paths are never normalized. */
export function explicitServiceCallerFile(env: NodeJS.ProcessEnv): string | undefined {
  const serviceCallerFile = env.RELAYFLOW_SERVICE_CALLER_FILE;
  return serviceCallerFile === undefined || serviceCallerFile === '' ? undefined : serviceCallerFile;
}

interface RelayRuntimeClient extends RemoteNodeSpawnClient, NodeResultInboxClient {
  agents: RemoteNodeSpawnClient['agents'] & { me(): Promise<NodeSpawnPublisher> };
  events: { disconnect(): Promise<void> };
}

const PUBLISHER_DISCOVERY_TIMEOUT_MS = 15_000;

export async function createRemoteNodeSpawnRuntime(
  env: NodeJS.ProcessEnv = process.env,
  options: { signal?: AbortSignal } = {},
): Promise<NodeSpawnRuntime> {
  const agentToken = env.RELAY_AGENT_TOKEN?.trim();
  if (!agentToken) throw new NodeSpawnError(
    'Node-spawn transport requires a dedicated publisher RELAY_AGENT_TOKEN.', 'publisher_token_required');
  const baseUrl = validateNodeSpawnBaseUrl(env.RELAY_BASE_URL?.trim() || 'https://cast.agentrelay.com');
  let RelaycastMessagingClient: new (options: Record<string, unknown>) => RelayRuntimeClient;
  try {
    ({ RelaycastMessagingClient } = await waitForRuntime(import('@agent-relay/sdk'), options.signal) as unknown as {
      RelaycastMessagingClient: new (options: Record<string, unknown>) => RelayRuntimeClient;
    });
  } catch (error) {
    if (options.signal?.aborted === true) throw options.signal.reason ?? error;
    throw new NodeSpawnError('Node-spawn transport requires optional @agent-relay/sdk >=17.2.1 <19.',
      'relay_sdk_unavailable', error);
  }
  const sandbox = env.RELAYFLOW_NODE_SANDBOX_ONLY?.trim();
  if (sandbox !== undefined && sandbox !== '' && sandbox !== '0' && sandbox !== '1') {
    throw new NodeSpawnError('RELAYFLOW_NODE_SANDBOX_ONLY must be 0 or 1', 'spawn_invalid_input');
  }
  const client = new RelaycastMessagingClient({ baseUrl, agentToken });
  const timeout = AbortSignal.timeout(PUBLISHER_DISCOVERY_TIMEOUT_MS);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  let publisher: NodeSpawnPublisher;
  try {
    publisher = await discoverPublisher(client, signal);
    if (!publisher.id?.trim() || !publisher.name?.trim()) {
      throw new NodeSpawnError('The node-spawn publisher token has no exact Relay identity', 'publisher_identity_missing');
    }
  } catch (error) {
    await client.events.disconnect().catch(() => undefined);
    throw error;
  }
  return {
    port: new RemoteNodeSpawnPort(client),
    inbox: { inbox: client.inbox },
    publisher,
    baseUrl,
    authority: 'remote',
    disconnect: () => client.events.disconnect(),
    ...(env.RELAYFLOW_NODE_NAME?.trim() ? { node: env.RELAYFLOW_NODE_NAME.trim() } : {}),
    ...(env.RELAYFLOW_NODE_REPO?.trim() ? { repo: env.RELAYFLOW_NODE_REPO.trim() } : {}),
    ...(sandbox === '1' ? { sandboxOnly: true } : {}),
  };
}

/**
 * Opens one explicitly configured Desktop service caller. The caller file is
 * the authority: there is no directory scan and no fallback to a remote token.
 */
export async function createLocalNodeSpawnRuntime(
  serviceCallerFile: string,
  options: { signal?: AbortSignal; bridge?: CoreBridgeApi } = {},
): Promise<NodeSpawnRuntime> {
  if (!serviceCallerFile || !isAbsolute(serviceCallerFile) || serviceCallerFile.includes('\0')) {
    throw new NodeSpawnError(
      'RELAYFLOW_SERVICE_CALLER_FILE must be an absolute path to caller.json',
      'caller_file_invalid',
    );
  }
  const bridge = options.bridge ?? await loadCoreBridge();
  const descriptor = await bridge.readCallerDescriptor(serviceCallerFile);
  const core = await bindCore(bridge, descriptor, options.signal);
  try {
    const identity = await bridge.serviceCallerIdentity(core, { signal: options.signal });
    bridge.assertServiceCallerIdentity(descriptor, identity);
    if (!identity.node.id.trim() || !identity.node.name.trim()) {
      throw new NodeSpawnError(
        'Desktop service-caller identity omitted its exact node identity',
        'caller_identity_mismatch',
      );
    }
    return {
      port: new LocalNodeSpawnPort(core, bridge, descriptor, identity.node),
      inbox: localResultInbox(bridge, descriptor),
      publisher: identity.publisher,
      baseUrl: identity.base_url,
      authority: 'desktop',
      node: identity.node.name,
      disconnect: async () => {
        await disconnectBoundCore(bridge, core);
      },
    };
  } catch (error) {
    await disconnectBoundCore(bridge, core, error);
    throw error; // unreachable; keeps the return type explicit
  }
}

/** Selects exactly one authority family and refuses ambiguous credentials. */
export async function createNodeSpawnRuntime(
  env: NodeJS.ProcessEnv = process.env,
  options: { signal?: AbortSignal; bridge?: CoreBridgeApi } = {},
): Promise<NodeSpawnRuntime> {
  const serviceCallerFile = explicitServiceCallerFile(env);
  const agentToken = env.RELAY_AGENT_TOKEN?.trim();
  if (serviceCallerFile !== undefined && agentToken) {
    throw new NodeSpawnError(
      'RELAYFLOW_SERVICE_CALLER_FILE and RELAY_AGENT_TOKEN name different node-spawn authorities; choose one',
      'ambiguous_publisher_authority',
    );
  }
  if (serviceCallerFile !== undefined) return createLocalNodeSpawnRuntime(serviceCallerFile, options);
  return createRemoteNodeSpawnRuntime(env, options);
}

/** One lazy publisher connection shared by every relay task on a worker. */
export function createNodeSpawnRuntimeOwner(
  provided?: NodeSpawnRuntime,
  factory: (signal: AbortSignal) => Promise<NodeSpawnRuntime> = signal =>
    createNodeSpawnRuntime(process.env, { signal }),
): NodeSpawnRuntimeOwner {
  const controller = new AbortController();
  let pending: Promise<NodeSpawnRuntime> | undefined;
  let established = provided;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const get = async (signal?: AbortSignal): Promise<NodeSpawnRuntime> => {
    signal?.throwIfAborted();
    if (closed) throw new NodeSpawnError('Node-spawn runtime owner is closed', 'task_cancelled');
    if (established !== undefined) return established;
    if (pending === undefined) {
      const created = factory(controller.signal).then(runtime => {
        established = runtime;
        return runtime;
      });
      pending = created;
      void created.catch(() => { if (pending === created) pending = undefined; });
    }
    return waitForRuntime(pending, signal);
  };
  const closeOnce = async (): Promise<void> => {
    closed = true;
    controller.abort(new Error('Node-spawn runtime owner closed'));
    if (provided !== undefined) return;
    const runtime = await pending?.catch(() => undefined);
    await runtime?.disconnect?.().catch(() => undefined);
  };
  return { get, peek: () => established, close: () => closePromise ??= closeOnce() };
}

async function bindCore(
  bridge: CoreBridgeApi,
  descriptor: CallerDescriptor,
  signal?: AbortSignal,
): Promise<CoreBridgeClient> {
  const core = await bridge.connectCore({ socket: descriptor.socket, signal });
  try {
    bridge.requireServiceCallerMethods(core);
    await bridge.authenticate(core, descriptor.credential, { signal });
    return core;
  } catch (error) {
    core.close();
    throw error;
  }
}

function localResultInbox(bridge: CoreBridgeApi, descriptor: CallerDescriptor): NodeResultInboxClient {
  const settle = async (action: 'ack' | 'fail', itemId: string): Promise<void> => {
    const core = await bindCore(bridge, descriptor);
    let failure: unknown;
    try {
      if (action === 'ack') await bridge.serviceCallerInboxAck(core, itemId);
      else await bridge.serviceCallerInboxFail(core, itemId);
    } catch (error) { failure = error; }
    await disconnectBoundCore(bridge, core, failure);
  };
  return { inbox: {
    subscribe(input = {}) {
      const invocationId = input.invocationId?.trim();
      if (!invocationId) {
        throw new NodeSpawnError(
          'Local result inbox requires the exact spawn invocation id',
          'result_identity_missing',
        );
      }
      return localInboxSubscription(
        bridge,
        descriptor,
        invocationId,
        input.signal,
      );
    },
    async ack(input) { await settle('ack', input.inboxItemId); },
    async fail(input) { await settle('fail', input.inboxItemId); },
  } };
}

function localInboxSubscription(
  bridge: CoreBridgeApi,
  descriptor: CallerDescriptor,
  invocationId: string,
  signal?: AbortSignal,
): AsyncIterable<{ id: string; message: { id: string; text: string; from: { id?: string; name?: string } } }> {
  return { [Symbol.asyncIterator]() {
    let core: CoreBridgeClient | undefined;
    let binding: Promise<CoreBridgeClient> | undefined;
    let opening: Promise<void> | undefined;
    let iteratorId: string | undefined;
    let closed = false;
    let closePromise: Promise<void> | undefined;
    let resolveClosed!: (result: { failure?: unknown }) => void;
    const closedPromise = new Promise<{ failure?: unknown }>(resolve => {
      resolveClosed = resolve;
    });
    const closeOnce = async (): Promise<void> => {
      closed = true;
      let failure: unknown;
      if (opening !== undefined) {
        try { await opening; }
        catch (error) { failure = error; }
      }
      const bound = core;
      if (bound === undefined) {
        resolveClosed(failure === undefined ? {} : { failure });
        if (failure !== undefined) throw failure;
        return;
      }
      try {
        if (iteratorId !== undefined) await bridge.serviceCallerInboxClose(bound, iteratorId);
      } catch (error) { failure ??= error; }
      try {
        await disconnectBoundCore(bridge, bound, failure);
        resolveClosed({});
      } catch (error) {
        resolveClosed({ failure: error });
        throw error;
      }
    };
    const close = (): Promise<void> => closePromise ??= closeOnce();
    const ensureOpen = (): Promise<void> => opening ??= (async () => {
      binding ??= bindCore(bridge, descriptor, signal);
      core = await binding;
      if (closed) return;
      const opened = await bridge.serviceCallerInboxOpen(core, invocationId, { signal });
      iteratorId = opened.iterator_id;
    })();
    return {
      async next() {
        for (;;) {
          signal?.throwIfAborted();
          if (closed) return { done: true, value: undefined };
          if (core === undefined) {
            await ensureOpen();
            if (closed) {
              await close();
              return { done: true, value: undefined };
            }
          }
          const bound = core;
          if (bound === undefined || iteratorId === undefined) {
            throw new NodeSpawnError('Desktop inbox binding did not return an iterator',
              'invalid_core_response');
          }
          const result = await bridge.serviceCallerInboxNext(bound, iteratorId, 30_000, { signal });
          if (result.delivery !== null) {
            if (result.delivery.invocation_id !== invocationId) {
              throw new NodeSpawnError(
                'Desktop returned a result outside the subscribed spawn invocation',
                'result_identity_mismatch',
              );
            }
            return { done: false as const, value: mapInboxDelivery(result.delivery, closedPromise) };
          }
        }
      },
      async return() {
        await close();
        return { done: true as const, value: undefined };
      },
    };
  } };
}

async function disconnectBoundCore(
  bridge: Pick<CoreBridgeApi, 'serviceCallerDisconnect'>,
  core: CoreBridgeClient,
  priorFailure?: unknown,
): Promise<void> {
  let disconnectFailure: unknown;
  try { await bridge.serviceCallerDisconnect(core); }
  catch (error) { disconnectFailure = error; }
  finally { core.close(); }
  if (priorFailure !== undefined) throw priorFailure;
  if (disconnectFailure !== undefined) throw disconnectFailure;
}

function mapInboxDelivery(delivery: CoreInboxDelivery, settlementReady: Promise<{ failure?: unknown }>) {
  return {
    id: delivery.item_id,
    settlementReady,
    message: {
      id: delivery.message_id,
      text: delivery.text ?? '',
      from: { id: delivery.sender.id, name: delivery.sender.name },
    },
    ...(delivery.failure === undefined ? {} : {
      terminalFailure: delivery.failure satisfies NodeResultTerminalFailure,
    }),
  };
}

async function waitForRuntime<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return pending;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([pending, aborted]); }
  finally { if (onAbort !== undefined) signal.removeEventListener('abort', onAbort); }
}

async function discoverPublisher(client: RelayRuntimeClient, signal: AbortSignal): Promise<NodeSpawnPublisher> {
  let onAbort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([client.agents.me(), aborted]);
  } catch (error) {
    throw error;
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

function validateNodeSpawnBaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch (error) {
    throw new NodeSpawnError('Invalid Agent Relay base URL', 'spawn_invalid_input', error);
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || !['https:', 'http:'].includes(url.protocol)) {
    throw new NodeSpawnError('Invalid Agent Relay base URL', 'spawn_invalid_input');
  }
  const loopback = url.hostname === '[::1]' || (isIP(url.hostname) === 4 && url.hostname.startsWith('127.'));
  if (url.protocol !== 'https:' && !loopback) {
    throw new NodeSpawnError('Agent Relay credentials require HTTPS outside literal loopback addresses', 'spawn_invalid_input');
  }
  return url.origin;
}
