import { stripTypeScriptTypes, register } from 'node:module';
import { createHook } from 'node:async_hooks';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';

/** A runtime with no-op promise hooks cannot distinguish await from ignored then. */
export function assertAuthoredPromiseHooks(): void {
  let initialized = false;
  let resolved = false;
  const hook = createHook({
    init(_id, type) { if (type === 'PROMISE') initialized = true; },
    promiseResolve() { resolved = true; },
  });
  try {
    hook.enable();
    void new Promise<void>((resolve) => resolve());
  } finally { hook.disable(); }
  if (!initialized || !resolved) throw new AuthoredFlowExecutionError(
    'unsupported_promise_lifecycle',
    'authored execution requires working Node promise hooks; use the standalone Node-authored runner with Node >=22.14',
  );
}

export function assertAuthoredNodeVersion(version = process.versions.node): void {
  const [major, minor] = version.split('.').map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor)
    || major! < 22 || (major === 22 && minor! < 14)
    || process.versions['bun'] !== undefined
    || typeof stripTypeScriptTypes !== 'function' || typeof register !== 'function') {
    throw new AuthoredFlowExecutionError('unsupported_promise_lifecycle',
      'the authored runner requires Node >=22.14; no workflow body was executed');
  }
  assertAuthoredPromiseHooks();
}
