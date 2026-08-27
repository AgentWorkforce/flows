import { describe, expect, it } from 'vitest';
import { compileAndHash, compileYaml, compileYamlToCanonicalJson, toKernelSpec } from '../src/compile.js';
import { canonicalize, specHash } from '../src/canonical.js';
import { SPEC_SCHEMA_VERSION } from '../src/spec.js';
import type { KernelRunSpec } from '../src/spec.js';

// Ladder rung (a) from RFC §3 Gate 1 done-when: a pure deterministic flow with
// zero agents (legalizing what the old validator rejected). No LLM, no agent.

const HELLO_YAML = `
version: '0.1.0'
name: hello-deterministic
description: The canonical hello ladder rung (a) — zero agents, legal.
steps:
  - id: greet
    type: deterministic
    command: "echo hello"
    verification:
      type: output_contains
      value: "hello"
  - id: shout
    type: deterministic
    dependsOn: [greet]
    command: "echo HELLO"
    verification:
      type: output_contains
      value: "HELLO"
`;

describe('compile: pure-deterministic hello flow (ladder rung a, zero agents)', () => {
  it('compiles YAML to a valid FlowSpec with zero agent/llm steps', () => {
    const spec = compileYaml(HELLO_YAML);
    expect(spec.version).toBe(SPEC_SCHEMA_VERSION);
    expect(spec.name).toBe('hello-deterministic');
    expect(spec.steps).toHaveLength(2);

    expect(spec.steps[0]?.type).toBe('deterministic');
    expect(spec.steps[0]?.id).toBe('greet');
    expect(spec.steps[0]?.maxIterations).toBe(1);

    const shout = spec.steps[1];
    expect(shout?.type).toBe('deterministic');
    expect(shout?.dependsOn).toEqual(['greet']);

    // Zero-agent invariant (RFC §1): no step is llm or agent.
    for (const step of spec.steps) {
      expect(step.type).toBe('deterministic');
    }
  });

  it('applies the implicit exit_code gate to a deterministic step with no verification', () => {
    const spec = compileYaml(`
version: '0.1.0'
name: implicit-gate
steps:
  - id: raw
    type: deterministic
    command: "true"
`);
    expect(spec.steps[0]?.verification).toEqual({ type: 'exit_code' });
  });

  it('preserves an explicit verification gate on a deterministic step', () => {
    const spec = compileYaml(HELLO_YAML);
    expect(spec.steps[0]?.verification).toEqual({
      type: 'output_contains',
      value: 'hello',
    });
  });

  it('emits kernel-dialect canonical JSON with a stable hash', () => {
    const json = compileYamlToCanonicalJson(HELLO_YAML);
    // Canonical: sorted keys, no whitespace, kernel dialect (snake_case,
    // flat verification, defaults materialized).
    expect(json).not.toContain('\n');
    expect(json).toContain('"depends_on":["greet"]');
    expect(json).toContain('"max_iterations":1');
    expect(json).toContain('"verification":{"output_contains":"hello"}');
    expect(json.indexOf('"id":"greet"')).toBeLessThan(json.indexOf('"type":"deterministic"'));

    const kernel = toKernelSpec(compileYaml(HELLO_YAML));
    expect(specHash(kernel)).toMatch(/^[0-9a-f]{64}$/);
    // Determinism: same input -> same hash.
    expect(specHash(toKernelSpec(compileYaml(HELLO_YAML)))).toBe(specHash(kernel));
    // canonicalize(JSON.parse(json)) is idempotent.
    expect(canonicalize(JSON.parse(json) as KernelRunSpec)).toBe(json);
    // Cross-boundary parity with the kernel's parser + spec_hash is pinned by
    // tests/spec-parity.test.ts and kernel/relayflowd-core/tests/spec_parity.rs.
  });

  it('compileAndHash returns spec + kernel spec + matching hash', () => {
    const { spec, kernelSpec, hash } = compileAndHash(HELLO_YAML);
    expect(spec.name).toBe('hello-deterministic');
    expect(kernelSpec.steps[0]?.depends_on).toEqual([]);
    expect(hash).toBe(specHash(kernelSpec));
  });
});
