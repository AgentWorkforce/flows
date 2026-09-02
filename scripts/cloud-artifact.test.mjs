import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  buildCloudArtifact,
  verifyArtifactDirectory,
  verifyCloudArtifact,
} from './cloud-artifact.mjs';

test('builds and verifies the exact Linux x64 Cloud artifact contract', async () => {
  const fixture = await fixtureRoot();
  try {
    const built = await buildCloudArtifact({
      relayflowd: fixture.relayflowd,
      flowsRuntime: fixture.flowsRuntime,
      outputDir: fixture.output,
      sourceCommit: 'a'.repeat(40),
    });
    const verified = await verifyCloudArtifact(built.archivePath, built.archiveSha256);
    assert.equal(verified.sourceCommit, 'a'.repeat(40));
    assert.deepEqual(
      verified.files.map((file) => file.path),
      ['bin/flows', 'bin/relayflowd', 'lib/flows-cli.mjs'],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('verification fails after a manifested runtime file is tampered', async () => {
  const fixture = await fixtureRoot();
  const unpacked = join(fixture.root, 'unpacked');
  try {
    const built = await buildCloudArtifact({
      relayflowd: fixture.relayflowd,
      flowsRuntime: fixture.flowsRuntime,
      outputDir: fixture.output,
      sourceCommit: 'b'.repeat(40),
    });
    await mkdir(unpacked);
    const extracted = spawnSync('tar', ['-xzf', built.archivePath, '-C', unpacked]);
    assert.equal(extracted.status, 0, extracted.stderr.toString());
    await writeFile(join(unpacked, 'lib', 'flows-cli.mjs'), 'tampered\n');
    await assert.rejects(verifyArtifactDirectory(unpacked), /file sha256 mismatch/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('outer checksum mismatch fails before extraction', async () => {
  const fixture = await fixtureRoot();
  try {
    const built = await buildCloudArtifact({
      relayflowd: fixture.relayflowd,
      flowsRuntime: fixture.flowsRuntime,
      outputDir: fixture.output,
      sourceCommit: 'c'.repeat(40),
    });
    await assert.rejects(
      verifyCloudArtifact(built.archivePath, '0'.repeat(64)),
      /archive sha256 mismatch/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), 'relayflow-cloud-artifact-'));
  const input = join(root, 'input');
  const output = join(root, 'output');
  await mkdir(input);
  const relayflowd = join(input, 'relayflowd');
  const flowsRuntime = join(input, 'flows-cli.mjs');
  const elfHeader = Buffer.alloc(64);
  elfHeader.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
  elfHeader.writeUInt16LE(62, 18);
  await writeFile(relayflowd, elfHeader);
  await writeFile(flowsRuntime, 'process.stdout.write("ok\\n");\n');
  assert.equal((await readFile(relayflowd))[0], 0x7f);
  return { root, output, relayflowd, flowsRuntime };
}
