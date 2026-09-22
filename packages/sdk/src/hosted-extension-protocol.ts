import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { clearTimeout as nodeClearTimeout, setTimeout as nodeSetTimeout } from 'node:timers';
import { snapshotJsonValue } from './json-value.js';
import { PluginError } from './plugin-manifest.js';

const HOSTED_WRITE = 'cloud:babysitter-turn';
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const ARRAY_IS_ARRAY = Array.isArray;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const CHILD_PROCESS_KILL = Function.prototype.call.bind(ChildProcess.prototype.kill) as (
  child: ChildProcess, signal?: NodeJS.Signals | number,
) => boolean;
const EVENT_ON = Function.prototype.call.bind(EventEmitter.prototype.on) as (
  emitter: EventEmitter, event: string, listener: (...args: unknown[]) => void,
) => EventEmitter;
const JSON_PARSE = JSON.parse;
const JSON_STRINGIFY = JSON.stringify;
const OBJECT_CREATE = Object.create;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_KEYS = Object.keys;
const OBJECT_FREEZE = Object.freeze;
const PROMISE = Promise;
const PROMISE_THEN = Function.prototype.call.bind(Promise.prototype.then) as (
  promise: Promise<unknown>,
  fulfilled: (value: unknown) => void,
  rejected: (reason: unknown) => void,
) => Promise<unknown>;
const READABLE_SET_ENCODING = Function.prototype.call.bind(Readable.prototype.setEncoding) as (
  stream: Readable, encoding: BufferEncoding,
) => Readable;
const READABLE_RESUME = Function.prototype.call.bind(Readable.prototype.resume) as (
  stream: Readable,
) => Readable;
const CLEAR_TIMEOUT = nodeClearTimeout;
const SET_TIMEOUT = nodeSetTimeout;
const TIMER_SAMPLE = SET_TIMEOUT(() => undefined, 0);
const TIMER_UNREF = Function.prototype.call.bind(TIMER_SAMPLE.unref) as (
  timer: ReturnType<typeof SET_TIMEOUT>,
) => ReturnType<typeof SET_TIMEOUT>;
CLEAR_TIMEOUT(TIMER_SAMPLE);
const STRING = String;
const STRING_INDEX_OF = Function.prototype.call.bind(String.prototype.indexOf) as (
  value: string, search: string,
) => number;
const STRING_SLICE = Function.prototype.call.bind(String.prototype.slice) as (
  value: string, start?: number, end?: number,
) => string;
const WRITABLE_END = Function.prototype.call.bind(Writable.prototype.end) as (
  stream: Writable,
) => Writable;
const WRITABLE_WRITE = Function.prototype.call.bind(Writable.prototype.write) as (
  stream: Writable, chunk: string,
) => boolean;
const SNAPSHOT_LIMITS = Object.freeze({
  maxDepth: 64,
  maxNodes: 262_144,
  maxBytes: MAX_FRAME_BYTES,
});

export interface HostedExtensionProtocolResult {
  readonly completionReason: 'success';
  readonly capabilityCalls: 1;
}

/** A bounded JSON copy, stripped of prototypes and behavior. */
export function boundedJsonSnapshot(value: unknown, what: string): unknown {
  let snapshot: ReturnType<typeof snapshotJsonValue>;
  try { snapshot = snapshotJsonValue(value, what, SNAPSHOT_LIMITS); }
  catch {
    throw new PluginError('plugin_unsupported', `${what} is not bounded JSON data.`);
  }
  const encoded = JSON_STRINGIFY(snapshot);
  if (BUFFER_BYTE_LENGTH(encoded) > MAX_FRAME_BYTES) {
    throw new PluginError('plugin_unsupported', `${what} is not bounded JSON data.`);
  }
  return snapshot;
}

/**
 * Exchange hostile child frames for one parent-owned capability invocation.
 * Descriptor 3 is transport, never authority: every frame and both boundary
 * payloads are validated by the parent. A child writing descriptor 3 directly
 * can request only the same exact, single capability its context exposes.
 */
export async function exchangeHostedExtension(
  child: ChildProcess,
  protocol: Readable,
  stdin: Writable,
  stderr: Readable,
  timeoutMs: number,
  request: unknown,
  invoke: (request: unknown) => Promise<unknown>,
): Promise<HostedExtensionProtocolResult> {
  const requestSnapshot = boundedJsonSnapshot(request, 'hosted extension request');
  let buffer = '';
  let stderrText = '';
  let calls = 0;
  READABLE_SET_ENCODING(stderr, 'utf8');
  EVENT_ON(stderr, 'data', chunk => {
    stderrText = STRING_SLICE(stderrText + STRING(chunk), -MAX_STDERR_BYTES);
  });
  READABLE_RESUME(stderr);
  READABLE_SET_ENCODING(protocol, 'utf8');

  return await new PROMISE<HostedExtensionProtocolResult>((resolvePromise, rejectPromise) => {
    let settled = false;
    let capabilityState: 'none' | 'pending' | 'completed' | 'failed' = 'none';
    let capabilityError: Error | undefined;
    let deferredProtocolError: Error | undefined;
    const finish = (error?: Error, result?: HostedExtensionProtocolResult) => {
      if (settled) return;
      settled = true;
      CLEAR_TIMEOUT(timeout);
      WRITABLE_END(stdin);
      if (child.exitCode === null && child.signalCode === null) CHILD_PROCESS_KILL(child, 'SIGKILL');
      if (error !== undefined) rejectPromise(error);
      else resolvePromise(result!);
    };
    const failure = (error: unknown): Error => error instanceof Error
      ? error
      : new PluginError('plugin_unsupported', 'Hosted capability rejected with a non-error value.');
    const refuse = (message: string) => {
      const error = new PluginError('plugin_unsupported', message);
      CHILD_PROCESS_KILL(child, 'SIGKILL');
      if (capabilityState === 'pending') {
        deferredProtocolError ??= error;
        return;
      }
      finish(capabilityError ?? error);
    };
    const timeout = SET_TIMEOUT(() => {
      CHILD_PROCESS_KILL(child, 'SIGKILL');
      finish(new PluginError(
        'plugin_unsupported',
        capabilityState === 'pending'
          ? 'Hosted capability outcome is in doubt after the sandbox timeout.'
          : 'Hosted extension sandbox timed out.',
      ));
    }, timeoutMs);
    TIMER_UNREF(timeout);

    EVENT_ON(stdin, 'error', () => refuse('Hosted extension capability channel closed.'));
    EVENT_ON(protocol, 'error', () => refuse('Hosted extension protocol channel failed.'));
    EVENT_ON(protocol, 'data', chunk => {
      buffer += STRING(chunk);
      if (BUFFER_BYTE_LENGTH(buffer) > MAX_FRAME_BYTES) return refuse('Hosted extension protocol exceeded its size limit.');
      for (;;) {
        const end = STRING_INDEX_OF(buffer, '\n');
        if (end < 0) break;
        const line = STRING_SLICE(buffer, 0, end);
        buffer = STRING_SLICE(buffer, end + 1);
        let message: Record<string, unknown>;
        try {
          const parsed = JSON_PARSE(line) as unknown;
          if (typeof parsed !== 'object' || parsed === null || ARRAY_IS_ARRAY(parsed)) {
            return refuse('Hosted extension emitted a non-object protocol frame.');
          }
          message = boundedJsonSnapshot(
            parsed,
            'hosted extension protocol frame',
          ) as Record<string, unknown>;
        } catch { return refuse('Hosted extension emitted malformed protocol data.'); }

        if (message.type === 'capability') {
          if (!hasExactKeys(message, ['type', 'id', 'name', 'request'])) {
            return refuse('Hosted extension emitted a malformed capability frame.');
          }
          calls += 1;
          if (calls !== 1 || capabilityState !== 'none' || message.name !== HOSTED_WRITE || message.id !== 1) {
            return refuse('Hosted extension requested an undeclared or repeated capability.');
          }
          capabilityState = 'pending';
          void PROMISE_THEN(invoke(message.request),
            value => {
              if (settled) return;
              try {
                const snapshot = boundedJsonSnapshot(value, 'hosted capability result');
                capabilityState = 'completed';
                if (deferredProtocolError !== undefined) return finish(deferredProtocolError);
                WRITABLE_WRITE(stdin, capabilityResultFrame(true, snapshot));
              } catch (error) {
                capabilityError = failure(error);
                capabilityState = 'failed';
                WRITABLE_WRITE(stdin, capabilityResultFrame(false));
                finish(capabilityError);
              }
            },
            error => {
              if (settled) return;
              capabilityError = failure(error);
              capabilityState = 'failed';
              WRITABLE_WRITE(stdin, capabilityResultFrame(false));
              finish(capabilityError);
            },
          );
        } else if (message.type === 'result') {
          if (!hasExactKeys(message, ['type', 'completionReason', 'capabilityCalls'])
            || calls !== 1 || capabilityState !== 'completed'
            || message.completionReason !== 'success' || message.capabilityCalls !== 1) {
            return refuse('Hosted extension reported a completion without exactly one capability call.');
          }
          finish(undefined, OBJECT_FREEZE({ completionReason: 'success', capabilityCalls: 1 }));
        } else if (message.type === 'error') {
          if (!hasExactKeys(message, ['type', 'message']) || typeof message.message !== 'string') {
            return refuse('Hosted extension emitted a malformed error frame.');
          }
          const error = new PluginError(
            'plugin_unsupported',
            `Hosted extension failed: ${STRING_SLICE(message.message, 0, 8192)}`,
          );
          if (capabilityState === 'pending') {
            deferredProtocolError ??= error;
            return;
          }
          finish(capabilityError ?? error);
        } else return refuse('Hosted extension emitted an unknown protocol message.');
      }
    });
    READABLE_RESUME(protocol);
    EVENT_ON(child, 'error', () => refuse('Hosted extension sandbox could not start.'));
    EVENT_ON(child, 'close', code => {
      if (!settled) refuse(
        `Hosted extension sandbox exited without a valid completion (exit ${code ?? 'signal'})`
        + (stderrText === '' ? '' : `: ${stderrText}`),
      );
    });
    WRITABLE_WRITE(stdin, `${JSON_STRINGIFY(requestSnapshot)}\n`);
  });
}

function capabilityResultFrame(ok: boolean, value?: unknown): string {
  // JSON.stringify consults inherited `toJSON` before traversing an object.
  // Protocol envelopes therefore never inherit from the ambient prototype;
  // nested capability data is already a behavior-free bounded snapshot.
  const envelope = OBJECT_CREATE(null) as Record<string, unknown>;
  envelope.type = 'capability-result';
  envelope.id = 1;
  envelope.ok = ok;
  if (ok) envelope.value = value;
  else envelope.error = 'hosted capability refused';
  return `${JSON_STRINGIFY(envelope)}\n`;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  if (OBJECT_KEYS(value).length !== keys.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    if (!OBJECT_HAS_OWN(value, keys[index]!)) return false;
  }
  return true;
}
