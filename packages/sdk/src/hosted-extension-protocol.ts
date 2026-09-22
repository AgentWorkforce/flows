import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { snapshotJsonValue } from './json-value.js';
import { PluginError } from './plugin-manifest.js';

const HOSTED_WRITE = 'cloud:babysitter-turn';
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const JSON_PARSE = JSON.parse;
const JSON_STRINGIFY = JSON.stringify;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_KEYS = Object.keys;
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
  if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) {
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
  let buffer = '';
  let stderrText = '';
  let calls = 0;
  stderr.setEncoding('utf8');
  stderr.on('data', chunk => { stderrText = (stderrText + String(chunk)).slice(-MAX_STDERR_BYTES); });
  protocol.setEncoding('utf8');

  return await new Promise<HostedExtensionProtocolResult>((resolvePromise, rejectPromise) => {
    let settled = false;
    let capabilityState: 'none' | 'pending' | 'completed' | 'failed' = 'none';
    let capabilityError: Error | undefined;
    let deferredProtocolError: Error | undefined;
    const finish = (error?: Error, result?: HostedExtensionProtocolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (error !== undefined) rejectPromise(error);
      else resolvePromise(result!);
    };
    const failure = (error: unknown): Error => error instanceof Error
      ? error
      : new PluginError('plugin_unsupported', 'Hosted capability rejected with a non-error value.');
    const refuse = (message: string) => {
      const error = new PluginError('plugin_unsupported', message);
      child.kill('SIGKILL');
      if (capabilityState === 'pending') {
        deferredProtocolError ??= error;
        return;
      }
      finish(capabilityError ?? error);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new PluginError(
        'plugin_unsupported',
        capabilityState === 'pending'
          ? 'Hosted capability outcome is in doubt after the sandbox timeout.'
          : 'Hosted extension sandbox timed out.',
      ));
    }, timeoutMs);
    timeout.unref();

    stdin.on('error', () => refuse('Hosted extension capability channel closed.'));
    protocol.on('error', () => refuse('Hosted extension protocol channel failed.'));
    protocol.on('data', chunk => {
      buffer += String(chunk);
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) return refuse('Hosted extension protocol exceeded its size limit.');
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message: Record<string, unknown>;
        try {
          const parsed = JSON_PARSE(line) as unknown;
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return refuse('Hosted extension emitted a non-object protocol frame.');
          }
          message = parsed as Record<string, unknown>;
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
          void invoke(message.request).then(
            value => {
              if (settled) return;
              try {
                const snapshot = boundedJsonSnapshot(value, 'hosted capability result');
                capabilityState = 'completed';
                if (deferredProtocolError !== undefined) return finish(deferredProtocolError);
                stdin.write(`${JSON_STRINGIFY({ type: 'capability-result', id: 1, ok: true, value: snapshot })}\n`);
              } catch (error) {
                capabilityError = failure(error);
                capabilityState = 'failed';
                stdin.write(`${JSON_STRINGIFY({ type: 'capability-result', id: 1, ok: false, error: 'hosted capability refused' })}\n`);
                finish(capabilityError);
              }
            },
            error => {
              if (settled) return;
              capabilityError = failure(error);
              capabilityState = 'failed';
              stdin.write(`${JSON_STRINGIFY({ type: 'capability-result', id: 1, ok: false, error: 'hosted capability refused' })}\n`);
              finish(capabilityError);
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
          const error = new PluginError(
            'plugin_unsupported',
            `Hosted extension failed: ${message.message.slice(0, 8192)}`,
          );
          if (capabilityState === 'pending') {
            deferredProtocolError ??= error;
            return;
          }
          finish(capabilityError ?? error);
        } else return refuse('Hosted extension emitted an unknown protocol message.');
      }
    });
    child.once('error', () => refuse('Hosted extension sandbox could not start.'));
    child.once('close', code => {
      if (!settled) refuse(
        `Hosted extension sandbox exited without a valid completion (exit ${code ?? 'signal'})`
        + (stderrText === '' ? '' : `: ${stderrText}`),
      );
    });
    stdin.write(`${JSON_STRINGIFY(request)}\n`);
  });
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  if (OBJECT_KEYS(value).length !== keys.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    if (!OBJECT_HAS_OWN(value, keys[index]!)) return false;
  }
  return true;
}
