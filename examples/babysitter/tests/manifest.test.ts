import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { subscriptions } from '../subscriptions.ts';

// flows-plugin.json is the installable contract (`flows add github:…#examples/babysitter`);
// subscriptions.ts is the resident wake contract. They must be the same list,
// or an installer would grant a different event set than the flow registers.
const manifest = JSON.parse(readFileSync(new URL('../flows-plugin.json', import.meta.url), 'utf8'));

test('the manifest declares exactly the subscription contract, family by family', () => {
  assert.equal(manifest.schema, 2);
  assert.equal(manifest.kind, 'flow-extension');
  assert.equal(manifest.entry, 'babysitter.flow.ts');
  assert.equal(manifest.extends.handlers, true);
  const declared = manifest.triggers.flatMap((t: { provider: string; event: string; actions: string[] }) =>
    t.actions.map(action => `${t.provider}:${t.event}.${action}`));
  const registered = subscriptions.map(s => `${s.trigger.name}:${s.id}`);
  assert.deepEqual(declared, registered);
  assert.equal(declared.length, 11);
});

test('the manifest budget is the flow header budget, and the entry name is the file the flow lives in', () => {
  const source = readFileSync(new URL('../babysitter.flow.ts', import.meta.url), 'utf8');
  assert.match(source, /budget: \{ dollars: 8, wallclock: '45m' \}/);
  assert.deepEqual(manifest.permissions.budget, { dollars: 8, wallclock: '45m' });
});
