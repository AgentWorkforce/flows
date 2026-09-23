import { execFileSync } from 'node:child_process';
import { it, expect } from 'vitest';

it('round-trips the manifest contract through the built public SDK without executing a flow', () => {
  // The normal SDK test command builds dist first. A separate Node process avoids
  // Vitest/source aliases hiding a missing public export or broken emitted import.
  const sdkUrl = new URL('../dist/index.js', import.meta.url).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import {
      createFlowToolManifest, canonicalFlowToolManifest, parseFlowToolManifest,
      validateFlowToolInput, validateFlowToolResult,
      flowToolFunctionDefinition, flowToolMcpDefinition,
    } from ${JSON.stringify(sdkUrl)};

    const manifest = createFlowToolManifest({
      name: 'review_pull_request', description: 'A hold verdict is not approval.',
      flow: { name: 'pr-review', version: '1.0.0', digest: 'sha256:' + 'a'.repeat(64) },
      inputSchema: {
        type: 'object', properties: { pr: { type: 'integer', minimum: 1 } },
        required: ['pr'], additionalProperties: false,
      },
      resultSchema: {
        type: 'object', properties: { verdict: { enum: ['hold', 'pass'] } },
        required: ['verdict'], additionalProperties: false,
      },
    });
    const serialized = canonicalFlowToolManifest(manifest);
    const restored = parseFlowToolManifest(JSON.parse(serialized), manifest.digest);
    assert.deepEqual(restored, manifest);
    assert.equal(canonicalFlowToolManifest(restored), serialized);
    assert.ok(Object.isFrozen(restored.inputSchema));
    const input = validateFlowToolInput(restored, { pr: 42 });
    assert.deepEqual(input, Object.assign(Object.create(null), { pr: 42 }));
    assert.ok(Object.isFrozen(input));
    // This is a supplied result fixture, not the output of an executed flow.
    const result = validateFlowToolResult(restored, { verdict: 'hold' });
    assert.deepEqual(result, Object.assign(Object.create(null), { verdict: 'hold' }));
    assert.ok(Object.isFrozen(result));
    assert.throws(() => validateFlowToolInput(restored, { pr: '42' }), /schema validation failed/);
    assert.throws(() => validateFlowToolResult(restored, { verdict: 'completed' }), /schema validation failed/);
    assert.throws(() => parseFlowToolManifest({ ...restored, description: 'changed' }), /digest mismatch/);
    assert.throws(() => parseFlowToolManifest(restored, 'sha256:' + '0'.repeat(64)), /digest mismatch/);

    const native = flowToolFunctionDefinition(restored);
    const mcp = flowToolMcpDefinition(restored);
    assert.deepEqual(native, {
      type: 'function', name: restored.name, description: restored.description,
      parameters: restored.inputSchema,
    });
    assert.deepEqual(mcp, {
      name: restored.name, description: restored.description,
      inputSchema: restored.inputSchema, outputSchema: restored.resultSchema,
    });
    assert.equal('annotations' in mcp, false);
    assert.equal('strict' in native, false);
    console.log('FLOW_TOOL_PUBLIC_CONTRACT_OK');
  `], { encoding: 'utf8', timeout: 15_000 });
  expect(output.trim()).toBe('FLOW_TOOL_PUBLIC_CONTRACT_OK');
}, 20_000);
