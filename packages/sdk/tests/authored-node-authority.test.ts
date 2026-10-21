import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
  candidate = join(directory, 'node-candidate');
  writeFileSync(candidate, `#!/bin/sh\necho probe >> ${JSON.stringify(probes)}\nprintf '%s' '${JSON.stringify({ path: join(directory, 'node-candidate'), version: '22.14.0' })}'\n`);
  chmodSync(candidate, 0o755);
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

  it('re-probes when the candidate selection changes', () => {
    authoredNodeAuthorityForTest();
    const count = probeCount();
    const path = process.env['PATH'];
    process.env['PATH'] = `${directory}:${path ?? ''}`;
    try { authoredNodeAuthorityForTest(); } finally { process.env['PATH'] = path; }
    expect(probeCount()).toBe(count + 1);
  });
});
