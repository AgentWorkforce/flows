import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compileAndHash,
  compileYaml,
  compileYamlToCanonicalJson,
  toKernelSpec,
} from '../src/compile.js';
import { kernelToAuthoring } from '../src/index.js';

// The SDK half of the cross-boundary spec-parity gate. The shared fixture in
// testdata/ pins one spec dialect at the SDK<->kernel seam: this test proves
// the compiler emits exactly the fixture's canonical JSON and hash, and
// kernel/relayflowd-core/tests/spec_parity.rs proves the kernel parses that
// same artifact fail-closed and stamps the identical spec_hash. Together they
// make "sha256(canonical JSON) == kernel spec_hash" a tested fact, not a
// comment.

const TESTDATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'testdata');

function fixture(name: string): string {
  return readFileSync(join(TESTDATA, name), 'utf8');
}

describe('spec parity: one dialect at the SDK<->kernel boundary', () => {
  for (const name of ['hello-deterministic', 'hello-ladder', 'hello-llm', 'hello-agent']) {
    it(`compiles ${name} to the pinned canonical JSON`, () => {
      const yaml = fixture(`${name}.flow.yaml`);
      const canonical = compileYamlToCanonicalJson(yaml);
      expect(canonical).toBe(fixture(`${name}.spec.canonical.json`).trim());
    });

    it(`hashes ${name} to the pinned spec_hash`, () => {
      const yaml = fixture(`${name}.flow.yaml`);
      const { hash } = compileAndHash(yaml);
      expect(hash).toBe(fixture(`${name}.spec.sha256`).trim());
    });

    it(`round-trips ${name} across the kernel dialect`, () => {
      const flow = compileYaml(fixture(`${name}.flow.yaml`));
      expect(kernelToAuthoring(toKernelSpec(flow))).toEqual(flow);
    });
  }

  it('normalizes empty triggers exactly as kernel serialization does', () => {
    const yaml = `${fixture('hello-ladder.flow.yaml')}\ntriggers: []\n`;
    const flow = compileYaml(yaml);
    expect(flow.triggers).toBeUndefined();
    expect(kernelToAuthoring(toKernelSpec(flow))).toEqual(flow);
    expect(compileYamlToCanonicalJson(yaml)).toBe(fixture('hello-ladder.spec.canonical.json').trim());
    expect(compileAndHash(yaml).hash).toBe(fixture('hello-ladder.spec.sha256').trim());
  });

  it('refuses a kernel retry policy the authoring dialect cannot represent', () => {
    const flow = compileYaml(fixture('hello-ladder.flow.yaml'));
    const kernel = toKernelSpec(flow);
    kernel.steps[0]!.retry.initial_backoff_ms = 5;
    expect(() => kernelToAuthoring(kernel)).toThrow('retry.initial_backoff_ms');
  });

  // The trigger dialect. `toKernelSpec` used to spread `flow.triggers` through
  // untouched, so an event subscription reached the kernel in camelCase and
  // `relayflowd` -- `#[serde(deny_unknown_fields)]` over snake_case -- refused
  // the whole spec:
  //   malformed run spec: unknown field `dedupeKeyTemplate`, expected one of
  //   `id`, `executor`, `event_type`, `pattern`, `dedupe_key_template`,
  //   `stale_after_ms`
  // Nothing caught it because the committed fixtures are snake_case and no test
  // compiled a triggered flow through the SDK and compared the two. These do.
  for (const [flowFile, canonicalFile] of [
    ['event-triggered-flow.yaml', 'event-triggered-flow.spec.canonical.json'],
    ['hn-monitor.flow.yaml', 'hn-monitor.spec.canonical.json'],
    ['tick-heartbeat.flow.yaml', 'tick-heartbeat.spec.canonical.json'],
  ] as const) {
    it(`lowers ${flowFile}'s triggers to the kernel's snake_case dialect`, () => {
      expect(compileYamlToCanonicalJson(fixture(flowFile))).toBe(fixture(canonicalFile).trim());
    });
  }

  it('hashes tick-heartbeat to the pinned spec_hash', () => {
    expect(compileAndHash(fixture('tick-heartbeat.flow.yaml')).hash)
      .toBe(fixture('tick-heartbeat.spec.sha256').trim());
  });

  it('round-trips every trigger field across the kernel dialect', () => {
    const flow = compileYaml(fixture('tick-heartbeat.flow.yaml'));
    expect(kernelToAuthoring(toKernelSpec(flow))).toEqual(flow);
  });

  it('refuses a kernel trigger key the authoring dialect cannot represent', () => {
    const kernel = toKernelSpec(compileYaml(fixture('tick-heartbeat.flow.yaml')));
    (kernel.triggers![0] as Record<string, unknown>)['schedule'] = '*/5 * * * *';
    expect(() => kernelToAuthoring(kernel)).toThrow('spec.triggers[0]');
  });

  it('refuses nested proxy data before executing any trap', () => {
    const flow = compileYaml(fixture('hello-deterministic.flow.yaml'));
    const kernel = toKernelSpec(flow);
    let proxyTraps = 0;
    kernel.steps = new Proxy(kernel.steps, {
      getPrototypeOf(target) {
        proxyTraps += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        proxyTraps += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        proxyTraps += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    expect(() => kernelToAuthoring(kernel)).toThrow(/proxy/i);
    expect(proxyTraps).toBe(0);
  });

  it('round-trips flow, trigger, and step CLI declarations', () => {
    const flow = compileYaml(`
version: '0.1.0'
name: preflight-round-trip
cli: project-cli
triggers:
  - id: hourly
    executor: worker-a
steps:
  - id: answer
    type: llm
    prompt: answer
    cli: llm-cli
  - id: edit
    type: agent
    instruction: edit
    cli: agent-cli
`);
    expect(kernelToAuthoring(toKernelSpec(flow))).toEqual(flow);
  });
});
