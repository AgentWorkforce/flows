import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const protocol = JSON.parse(
  readFileSync(new URL('../benchmarks/workflow-reliability/protocol.json', import.meta.url)),
);

test('competitive claims name the participants required to support them', () => {
  assert.deepEqual(protocol.claims.buildVsBuy.requiredParticipants, [
    'relayflows',
    'diy-reference',
  ]);
  assert.deepEqual(protocol.claims.bestInClass.requiredParticipants, [
    'relayflows',
    'diy-reference',
    'temporal',
    'inngest',
  ]);
});

test('every workload has multiple implementation-neutral success predicates', () => {
  assert.ok(protocol.scenarios.length >= 6);
  for (const scenario of protocol.scenarios) {
    assert.match(scenario.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    assert.ok(scenario.workload.length > 20, scenario.id);
    assert.ok(scenario.successPredicates.length >= 3, scenario.id);
  }
});

test('the protocol keeps correctness, performance, and build burden separate', () => {
  assert.ok(protocol.metrics.primary.includes('duplicate_external_effect_rate'));
  assert.ok(protocol.metrics.performance.includes('provider_cost_per_successful_run'));
  assert.ok(protocol.metrics.buildBurden.includes('custom_persistence_retry_and_dedupe_source_lines'));
  assert.ok(
    protocol.fairnessControls.some((control) => control.includes('Do not form a composite score')),
  );
});
