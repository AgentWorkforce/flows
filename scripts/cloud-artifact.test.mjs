import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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
      flowsExecutable: fixture.flowsExecutable,
      outputDir: fixture.output,
      sourceCommit: 'a'.repeat(40),
    });
    const verified = await verifyCloudArtifact(built.archivePath, built.archiveSha256);
    assert.equal(verified.sourceCommit, 'a'.repeat(40));
    assert.deepEqual(
      verified.files.map((file) => file.path),
      ['bin/flows', 'bin/relayflowd'],
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
      flowsExecutable: fixture.flowsExecutable,
      outputDir: fixture.output,
      sourceCommit: 'b'.repeat(40),
    });
    await mkdir(unpacked);
    const extracted = spawnSync('tar', ['-xzf', built.archivePath, '-C', unpacked]);
    assert.equal(extracted.status, 0, extracted.stderr.toString());
    await writeFile(join(unpacked, 'bin', 'flows'), 'tampered\n');
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
      flowsExecutable: fixture.flowsExecutable,
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

test('verification rejects files not declared by the manifest', async () => {
  await withUnpackedArtifact('d', async (unpacked) => {
    await writeFile(join(unpacked, 'unexpected'), 'not declared\n');
    await assert.rejects(
      verifyArtifactDirectory(unpacked),
      /contents do not exactly match manifest files/u,
    );
  });
});

test('verification rejects a declared file missing from the artifact', async () => {
  await withUnpackedArtifact('4', async (unpacked) => {
    await rm(join(unpacked, 'bin', 'flows'));
    await assert.rejects(
      verifyArtifactDirectory(unpacked),
      /contents do not exactly match manifest files/u,
    );
  });
});

test('verification rejects a manifest path that escapes the artifact root', async () => {
  await withUnpackedArtifact('e', async (unpacked) => {
    const manifest = await readManifest(unpacked);
    manifest.files[0].path = '../outside';
    await writeManifest(unpacked, manifest);
    await assert.rejects(
      verifyArtifactDirectory(unpacked),
      /manifest contains an invalid file entry/u,
    );
  });
});

test('verification rejects an absolute manifest path', async () => {
  await withUnpackedArtifact('5', async (unpacked) => {
    const manifest = await readManifest(unpacked);
    manifest.files[0].path = '/tmp/outside';
    await writeManifest(unpacked, manifest);
    await assert.rejects(
      verifyArtifactDirectory(unpacked),
      /manifest contains an invalid file entry/u,
    );
  });
});

test('verification rejects a relayflowd whose declared bytes are not Linux x64 ELF', async () => {
  await withUnpackedArtifact('f', async (unpacked) => {
    const relayflowd = join(unpacked, 'bin', 'relayflowd');
    await writeFile(relayflowd, 'not an ELF binary\n');
    const manifest = await readManifest(unpacked);
    manifest.files.find((file) => file.path === 'bin/relayflowd').sha256 =
      await sha256File(relayflowd);
    await writeManifest(unpacked, manifest);
    await assert.rejects(
      verifyArtifactDirectory(unpacked),
      /must be a little-endian Linux x86-64 ELF binary/u,
    );
  });
});

test('verification rejects a required binary whose execute mode was stripped', async () => {
  await withUnpackedArtifact('1', async (unpacked) => {
    await chmod(join(unpacked, 'bin', 'relayflowd'), 0o644);
    await assert.rejects(
      verifyArtifactDirectory(unpacked),
      /executable mode mismatch for bin\/relayflowd/u,
    );
  });
});

test('verification rejects a required executable omitted by the manifest contract', async () => {
  await withUnpackedArtifact('2', async (unpacked) => {
    const flows = join(unpacked, 'bin', 'flows');
    await chmod(flows, 0o644);
    const manifest = await readManifest(unpacked);
    manifest.files.find((file) => file.path === 'bin/flows').executable = false;
    await writeManifest(unpacked, manifest);
    await assert.rejects(
      verifyArtifactDirectory(unpacked),
      /manifest is missing executable bin\/flows/u,
    );
  });
});

test('manifest pins journal protocol version zero', async () => {
  const fixture = await fixtureRoot();
  try {
    const built = await buildCloudArtifact({
      relayflowd: fixture.relayflowd,
      flowsExecutable: fixture.flowsExecutable,
      outputDir: fixture.output,
      sourceCommit: '3'.repeat(40),
    });
    assert.equal(built.manifest.protocolVersion, '0');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('CLI rejects a misspelled build option in artifact vocabulary', () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./cloud-artifact.mjs', import.meta.url)),
    'build',
    '--flows-executabl',
    'flows',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr.toString(), /unknown option --flows-executabl for build/u);
});

test('CLI reports a missing verify option before touching the filesystem', () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./cloud-artifact.mjs', import.meta.url)),
    'verify',
    '--archive',
    'artifact.tar.gz',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr.toString(), /missing required option --sha256/u);
});

async function withUnpackedArtifact(commitDigit, verify) {
  const fixture = await fixtureRoot();
  const unpacked = join(fixture.root, 'unpacked');
  try {
    const built = await buildCloudArtifact({
      relayflowd: fixture.relayflowd,
      flowsExecutable: fixture.flowsExecutable,
      outputDir: fixture.output,
      sourceCommit: commitDigit.repeat(40),
    });
    await mkdir(unpacked);
    const extracted = spawnSync('tar', ['-xzf', built.archivePath, '-C', unpacked]);
    assert.equal(extracted.status, 0, extracted.stderr.toString());
    await verify(unpacked);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function readManifest(root) {
  return JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
}

async function writeManifest(root, manifest) {
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), 'relayflow-cloud-artifact-'));
  const input = join(root, 'input');
  const output = join(root, 'output');
  await mkdir(input);
  const relayflowd = join(input, 'relayflowd');
  const flowsExecutable = join(input, 'flows');
  const elfHeader = Buffer.alloc(64);
  elfHeader.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
  elfHeader.writeUInt16LE(62, 18);
  await writeFile(relayflowd, elfHeader);
  await writeFile(flowsExecutable, elfHeader);
  return { root, output, relayflowd, flowsExecutable };
}
