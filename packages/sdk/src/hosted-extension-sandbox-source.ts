/**
 * Source for the process that imports one hosted extension inside the Linux
 * namespace assembled by hosted-extension-isolation.ts.
 *
 * Keep this dependency-free. The parent writes it to a private file and
 * mounts that file read-only; the extension is not imported by the host.
 */
export const HOSTED_EXTENSION_SANDBOX_SOURCE = String.raw`
import { createReadStream, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const lines = createInterface({ input: createReadStream(null, { fd: 0 }), crlfDelay: Infinity });
const iterator = lines[Symbol.asyncIterator]();
const send = value => writeSync(3, JSON.stringify(value) + '\n');
const receive = async () => {
  const next = await iterator.next();
  if (next.done) throw new Error('hosted capability channel closed');
  return JSON.parse(next.value);
};
const subscriptionOf = handler => {
  const trigger = handler?.trigger;
  const filter = trigger?.filter;
  if (trigger?.kind !== 'webhook' || filter === undefined
    || typeof filter.provider !== 'string' || filter.provider !== trigger.name
    || typeof filter.type !== 'string') return undefined;
  const action = typeof filter.payload === 'object' && filter.payload !== null && !Array.isArray(filter.payload)
    ? filter.payload.action : undefined;
  if (action !== undefined && typeof action !== 'string') return undefined;
  return action === undefined
    ? { provider: filter.provider, event: filter.type }
    : { provider: filter.provider, event: filter.type, action };
};
const matches = (subscription, identity) => subscription !== undefined
  && subscription.provider === identity.provider
  && subscription.event === identity.event
  && (subscription.action === undefined || subscription.action === identity.action);

try {
  const request = await receive();
  if (request?.type !== 'execute' || typeof request.entry !== 'string'
    || typeof request.surfaceRuntime !== 'string' || typeof request.capability !== 'string') {
    throw new Error('malformed hosted extension execution request');
  }
  const runtime = await import(pathToFileURL(request.surfaceRuntime).href);
  const authored = await import(pathToFileURL(request.entry).href);
  const definition = runtime.getFlowDefinition(authored.default);
  const selected = definition.handlers.filter(handler => matches(subscriptionOf(handler), request.identity));
  if (selected.length !== 1) throw new Error('hosted event must match exactly one isolated extension handler');

  let nextCall = 1;
  let capabilityCalls = 0;
  let completion;
  const invoke = async value => {
    capabilityCalls += 1;
    if (capabilityCalls !== 1) throw new Error('hosted extension may invoke its capability once');
    const id = nextCall++;
    send({ type: 'capability', id, name: request.capability, request: value });
    const response = await receive();
    if (response?.type !== 'capability-result' || response.id !== id || typeof response.ok !== 'boolean') {
      throw new Error('malformed hosted capability response');
    }
    if (!response.ok) throw new Error(typeof response.error === 'string' ? response.error : 'hosted capability refused');
    return response.value;
  };
  const capabilities = Object.freeze({
    cloud: Object.freeze({ babysitterTurn: Object.freeze({ queue: invoke }) }),
  });
  const available = Object.freeze({
    capabilities,
    done(reason) {
      if (completion !== undefined) throw new Error('hosted extension completed more than once');
      completion = reason;
    },
  });
  const context = new Proxy(available, {
    get(target, property, receiver) {
      if (property !== 'capabilities' && property !== 'done') {
        throw new Error('hosted extension context denies ' + String(property));
      }
      return Reflect.get(target, property, receiver);
    },
    has(_target, property) { return property === 'capabilities' || property === 'done'; },
    ownKeys() { return ['capabilities', 'done']; },
  });
  await selected[0].body(context, request.input);
  if (capabilityCalls !== 1) throw new Error('hosted extension did not invoke its capability exactly once');
  if (completion !== 'success') throw new Error('hosted extension did not complete with success');
  send({ type: 'result', completionReason: completion, capabilityCalls });
} catch (error) {
  send({ type: 'error', message: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  process.exitCode = 1;
}
`;
