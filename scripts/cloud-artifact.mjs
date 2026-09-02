#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA256 = /^[a-f0-9]{64}$/u;
const SOURCE_COMMIT = /^[a-f0-9]{40}$/u;
const REQUIRED_EXECUTABLES = ['bin/flows', 'bin/relayflowd'];

export async function buildCloudArtifact(options) {
  assertSourceCommit(options.sourceCommit);
  const relayflowd = resolve(options.relayflowd);
  const flowsExecutable = resolve(options.flowsExecutable);
  await assertRegularFile(relayflowd);
  await assertRegularFile(flowsExecutable);
  await assertLinuxX64Elf(relayflowd);
  await assertLinuxX64Elf(flowsExecutable, 'flows');

  const outputDir = resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const stageParent = await mkdtemp(join(tmpdir(), 'relayflow-v2-stage-'));
  const stage = join(stageParent, 'runtime');
  try {
    await mkdir(join(stage, 'bin'), { recursive: true });
    await copyFile(relayflowd, join(stage, 'bin', 'relayflowd'));
    await copyFile(flowsExecutable, join(stage, 'bin', 'flows'));
    await chmod(join(stage, 'bin', 'relayflowd'), 0o755);
    await chmod(join(stage, 'bin', 'flows'), 0o755);

    const manifest = await createManifest(stage, options.sourceCommit);
    await writeFile(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await verifyArtifactDirectory(stage);

    const temporaryArchivePath = join(
      outputDir,
      `.relayflow-v2-${options.sourceCommit}-${process.pid}.tar.gz.tmp`,
    );
    run('tar', ['-czf', temporaryArchivePath, '-C', stage, '.']);
    const archiveSha256 = await sha256File(temporaryArchivePath);
    const fileName =
      `relayflow-v2-${options.sourceCommit}-${archiveSha256.slice(0, 16)}-linux-x64.tar.gz`;
    const archivePath = join(outputDir, fileName);
    await rename(temporaryArchivePath, archivePath);
    const checksumPath = `${archivePath}.sha256`;
    await writeFile(checksumPath, `${archiveSha256}  ${fileName}\n`);
    return { archivePath, checksumPath, archiveSha256, manifest };
  } finally {
    await rm(stageParent, { recursive: true, force: true });
  }
}

export async function verifyCloudArtifact(archivePath, expectedSha256) {
  // expectedSha256 is a trust input supplied independently by the artifact
  // publisher. This detects corruption or substitution relative to that trusted
  // digest; it does not authenticate an archive and its sibling checksum file.
  const archive = resolve(archivePath);
  await assertRegularFile(archive);
  if (!SHA256.test(expectedSha256)) {
    throw new Error('expected archive sha256 must be 64 lowercase hexadecimal characters');
  }
  const actualSha256 = await sha256File(archive);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `archive sha256 mismatch: expected ${expectedSha256}, received ${actualSha256}`,
    );
  }
  const extractParent = await mkdtemp(join(tmpdir(), 'relayflow-v2-verify-'));
  try {
    run('tar', ['-xzf', archive, '-C', extractParent]);
    return await verifyArtifactDirectory(extractParent);
  } finally {
    await rm(extractParent, { recursive: true, force: true });
  }
}

export async function verifyArtifactDirectory(root) {
  const manifestPath = join(root, 'manifest.json');
  const manifest = parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  const actualPaths = (await listFiles(root))
    .filter((path) => path !== 'manifest.json')
    .sort();
  const declaredPaths = manifest.files.map((file) => file.path).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(declaredPaths)) {
    throw new Error('artifact contents do not exactly match manifest files');
  }
  for (const file of manifest.files) {
    const path = join(root, file.path);
    await assertRegularFile(path);
    const actualSha256 = await sha256File(path);
    if (actualSha256 !== file.sha256) {
      throw new Error(`file sha256 mismatch for ${file.path}`);
    }
    const actualExecutable = ((await stat(path)).mode & 0o111) !== 0;
    if (actualExecutable !== file.executable) {
      throw new Error(`executable mode mismatch for ${file.path}`);
    }
  }
  for (const required of REQUIRED_EXECUTABLES) {
    const entry = manifest.files.find((file) => file.path === required);
    if (!entry?.executable) throw new Error(`manifest is missing executable ${required}`);
  }
  await assertLinuxX64Elf(join(root, 'bin', 'relayflowd'));
  return manifest;
}

async function createManifest(root, sourceCommit) {
  const paths = (await listFiles(root)).sort();
  return {
    schemaVersion: 1,
    protocolVersion: '0',
    sourceCommit,
    platform: 'linux',
    arch: 'x64',
    files: await Promise.all(
      paths.map(async (path) => ({
        path,
        sha256: await sha256File(join(root, path)),
        executable: ((await stat(join(root, path))).mode & 0o111) !== 0,
      })),
    ),
  };
}

function parseManifest(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    value.schemaVersion !== 1 ||
    value.protocolVersion !== '0' ||
    value.platform !== 'linux' ||
    value.arch !== 'x64' ||
    !SOURCE_COMMIT.test(value.sourceCommit) ||
    !Array.isArray(value.files)
  ) {
    throw new Error('artifact manifest has an unsupported schema or target');
  }
  const seen = new Set();
  for (const file of value.files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      file.path.startsWith('/') ||
      file.path.split('/').some((part) => part === '' || part === '.' || part === '..') ||
      !SHA256.test(file.sha256) ||
      typeof file.executable !== 'boolean' ||
      seen.has(file.path)
    ) {
      throw new Error('artifact manifest contains an invalid file entry');
    }
    seen.add(file.path);
  }
  return value;
}

async function listFiles(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`artifact contains non-regular entry ${path}`);
  }
  return files;
}

async function assertRegularFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile()) {
    throw new Error(`expected regular file: ${path}`);
  }
}

async function assertLinuxX64Elf(path, executableName = 'relayflowd') {
  const header = (await readFile(path)).subarray(0, 20);
  const isElf64X64 =
    header.length === 20 &&
    header[0] === 0x7f &&
    header[1] === 0x45 &&
    header[2] === 0x4c &&
    header[3] === 0x46 &&
    header[4] === 2 &&
    header[5] === 1 &&
    header.readUInt16LE(18) === 62;
  if (!isElf64X64) {
    throw new Error(`${executableName} must be a little-endian Linux x86-64 ELF binary`);
  }
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function assertSourceCommit(value) {
  if (!SOURCE_COMMIT.test(value)) {
    throw new Error('source commit must be a full lowercase git SHA');
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
}

function parseArgs(args) {
  const command = args[0];
  const required =
    command === 'build'
      ? ['relayflowd', 'flows-executable', 'output-dir', 'source-commit']
      : command === 'verify'
        ? ['archive', 'sha256']
        : null;
  if (!required) throw new Error('usage: cloud-artifact.mjs build|verify [options]');
  const values = {};
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || value === undefined) throw new Error('invalid arguments');
    const option = name.slice(2);
    if (!required.includes(option)) throw new Error(`unknown option --${option} for ${command}`);
    if (values[option] !== undefined) throw new Error(`duplicate option --${option}`);
    values[option] = value;
  }
  for (const option of required) {
    if (values[option] === undefined) throw new Error(`missing required option --${option}`);
  }
  return { command, values };
}

async function main(args) {
  const { command, values } = parseArgs(args);
  if (command === 'build') {
    const result = await buildCloudArtifact({
      relayflowd: values.relayflowd,
      flowsExecutable: values['flows-executable'],
      outputDir: values['output-dir'],
      sourceCommit: values['source-commit'],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === 'verify') {
    const manifest = await verifyCloudArtifact(values.archive, values.sha256);
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
    return;
  }
  throw new Error('usage: cloud-artifact.mjs build|verify [options]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
