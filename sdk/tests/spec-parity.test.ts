import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compileAndHash,
  compileYaml,
  compileYamlToCanonicalJson,
  kernelToAuthoring,
  toKernelSpec,
} from '../src/compile.js';

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
  for (const name of ['hello-ladder', 'hello-llm', 'hello-agent']) {
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
});
