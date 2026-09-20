import assert from 'node:assert/strict';
import test from 'node:test';
import { capabilities } from '../capabilities.ts';
// Intentionally RED dependency assertions, retained as TODO failures. These are
// not passing acceptance gates and must never be counted as implemented effects.
for (const [name, dependency] of Object.entries({
  atomicPrPublication: 'Provider per-PR serialization + head-guarded idempotent owned-comment upsert',
  durableCrossRunNotification: 'Durable per-head notification receipt and atomic delivery claim',
  journaledCiObservation: 'Journal-backed script-memory write/recall across runs (memory.learn currently refuses)',
  enforcedAgentWriteScope: 'Enforced readonly agent workspace and credential scopes (gate 8 / #442)',
  selectiveAgentExitRetry: 'Typed agent exit-code/retry policy in authored Step; AgentResult only has summary/artifacts',
})) {
  test(name, { todo: dependency }, () => assert.equal(capabilities[name as keyof typeof capabilities], true));
}
