import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authoredNodeAuthorityForTest, installAuthoredNodeSource } from '../src/authored-node-runner.js';

// The probe spawns the Node candidate and hashes its whole executable. One CLI
// run used to do both twice on the startup path (before root admission and
// again before spawning the body). The candidate here is a stand-in that
// answers the probe and records each invocation; its own file is the
// executable the authority fingerprints and hashes.
let directory: string, candidate: string, probes: string, previousOverride: string | undefined;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'authored-node-authority-'));
  probes = join(directory, 'probes');
  writeFileSync(probes, '');
  candidate = writeCandidate('node-candidate');
  previousOverride = process.env['FLOWS_AUTHORED_NODE'];
  process.env['FLOWS_AUTHORED_NODE'] = candidate;
  installAuthoredNodeSource('export {};\n');
});

afterAll(() => {
  if (previousOverride === undefined) delete process.env['FLOWS_AUTHORED_NODE'];
  else process.env['FLOWS_AUTHORED_NODE'] = previousOverride;
  rmSync(directory, { recursive: true, force: true });
});

const probeCount = (): number => readFileSync(probes, 'utf8').split('\n').filter(Boolean).length;

/** A stand-in Node that answers the probe with its own path and records the call. */
function writeCandidate(name: string): string {
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\necho probe >> ${JSON.stringify(probes)}\nprintf '%s' '${JSON.stringify({ path, version: '22.14.0' })}'\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('authored Node authority', () => {
  it('probes and hashes the executable once per process while it is unchanged', () => {
    const first = authoredNodeAuthorityForTest();
    const second = authoredNodeAuthorityForTest();
    expect(probeCount()).toBe(1);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ path: realpathSync(candidate), version: '22.14.0' });
    expect(first.executableSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('re-probes and re-hashes when the executable file changes', () => {
    const before = authoredNodeAuthorityForTest();
    const count = probeCount();
    writeFileSync(candidate, readFileSync(candidate, 'utf8') + '# replaced\n');
    const later = new Date(Date.now() + 60_000);
    utimesSync(candidate, later, later);
    const after = authoredNodeAuthorityForTest();
    expect(probeCount()).toBe(count + 1);
    expect(after.executableSha256).not.toBe(before.executableSha256);
  });

  it('re-probes when the override selects a different executable', () => {
    authoredNodeAuthorityForTest();
    const count = probeCount();
    const other = writeCandidate('other-candidate');
    process.env['FLOWS_AUTHORED_NODE'] = other;
    try {
      expect(authoredNodeAuthorityForTest().path).toBe(realpathSync(other));
    } finally { process.env['FLOWS_AUTHORED_NODE'] = candidate; }
    expect(probeCount()).toBe(count + 1);
  });

  it('re-probes when the selected override symlink is retargeted while the old binary remains', () => {
    const first = writeCandidate('symlink-target-a');
    const second = writeCandidate('symlink-target-b');
    const selected = join(directory, 'selected-node');
    symlinkSync(first, selected);
    process.env['FLOWS_AUTHORED_NODE'] = selected;
    try {
      expect(authoredNodeAuthorityForTest().path).toBe(realpathSync(first));
      const count = probeCount();
      expect(authoredNodeAuthorityForTest().path).toBe(realpathSync(first));
      expect(probeCount()).toBe(count);
      unlinkSync(selected);
      symlinkSync(second, selected);
      expect(authoredNodeAuthorityForTest().path).toBe(realpathSync(second));
      expect(probeCount()).toBe(count + 1);
    } finally { process.env['FLOWS_AUTHORED_NODE'] = candidate; }
  });

  it('re-probes when the `node` found on PATH is retargeted', () => {
    const first = writeCandidate('path-target-a');
    const second = writeCandidate('path-target-b');
    const bin = mkdtempSync(join(directory, 'bin-'));
    const node = join(bin, 'node');
    symlinkSync(first, node);
    const path = process.env['PATH'];
    delete process.env['FLOWS_AUTHORED_NODE'];
    process.env['PATH'] = `${bin}:/usr/bin:/bin`;
    try {
      expect(authoredNodeAuthorityForTest().path).toBe(realpathSync(first));
      const count = probeCount();
      expect(authoredNodeAuthorityForTest().path).toBe(realpathSync(first));
      expect(probeCount()).toBe(count);
      unlinkSync(node);
      symlinkSync(second, node);
      expect(authoredNodeAuthorityForTest().path).toBe(realpathSync(second));
      expect(probeCount()).toBe(count + 1);
    } finally {
      process.env['PATH'] = path;
      process.env['FLOWS_AUTHORED_NODE'] = candidate;
    }
  });
});
