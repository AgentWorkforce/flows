import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { socketPathFor } from '../src/daemon-connection.js';
import { assertHostedDataDirectoryIsolated } from '../src/hosted-data-directory.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
});

async function project(): Promise<{ root: string; flowPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'hosted-data-directory-'));
  roots.push(root);
  const flowPath = join(root, 'software-factory.flow.yaml');
  await writeFile(join(root, 'flows.json'), '{}\n');
  await writeFile(flowPath, 'version: v1\n');
  return { root: await realpath(root), flowPath };
}

describe('hosted data directory isolation', () => {
  it('allows the conventional project journal and an external directory', async () => {
    const installed = await project();
    const external = await mkdtemp(join(tmpdir(), 'hosted-data-external-'));
    roots.push(external);

    await expect(assertHostedDataDirectoryIsolated(
      installed.flowPath,
      join(installed.root, '.relayflowd', 'nested'),
    )).resolves.toEqual({
      dataDir: join(installed.root, '.relayflowd', 'nested'),
      receiptDirectory: join(installed.root, '.relayflowd', 'nested', 'hosted-extension-receipts'),
    });
    await expect(assertHostedDataDirectoryIsolated(installed.flowPath, external)).resolves.toEqual({
      dataDir: resolve(external),
      receiptDirectory: join(await realpath(external), 'hosted-extension-receipts'),
    });
  });

  it('preserves lexical daemon identity while canonicalizing receipt storage', async () => {
    const installed = await project();
    const external = await mkdtemp(join(tmpdir(), 'hosted-data-target-'));
    const aliases = await mkdtemp(join(tmpdir(), 'hosted-data-alias-'));
    roots.push(external, aliases);
    await symlink(external, join(aliases, 'journal-link'));
    const lexicalDataDir = join(aliases, 'journal-link', 'state');

    const validated = await assertHostedDataDirectoryIsolated(
      installed.flowPath,
      lexicalDataDir,
    );
    expect(validated).toEqual({
      dataDir: resolve(lexicalDataDir),
      receiptDirectory: join(await realpath(external), 'state', 'hosted-extension-receipts'),
    });
    expect(socketPathFor(validated.dataDir)).toBe(socketPathFor(lexicalDataDir));
  });

  it('refuses a custom in-project directory even when it does not exist', async () => {
    const installed = await project();
    await expect(assertHostedDataDirectoryIsolated(
      installed.flowPath,
      join(installed.root, 'state', 'journal'),
    )).rejects.toMatchObject({ code: 'plugin_source_invalid' });
  });

  it('canonicalizes existing symlink parents before applying the boundary', async () => {
    const installed = await project();
    const outside = await mkdtemp(join(tmpdir(), 'hosted-data-link-'));
    roots.push(outside);
    await mkdir(join(installed.root, 'state'));
    await symlink(join(installed.root, 'state'), join(outside, 'journal-link'));

    await expect(assertHostedDataDirectoryIsolated(
      installed.flowPath,
      join(outside, 'journal-link', 'nested'),
    )).rejects.toMatchObject({ code: 'plugin_source_invalid' });
  });

  it('refuses a receipt-directory symlink back into hosted project source', async () => {
    const installed = await project();
    await mkdir(join(installed.root, '.relayflowd'));
    await mkdir(join(installed.root, 'source-state'));
    await symlink(
      join(installed.root, 'source-state'),
      join(installed.root, '.relayflowd', 'hosted-extension-receipts'),
    );

    await expect(assertHostedDataDirectoryIsolated(
      installed.flowPath,
      join(installed.root, '.relayflowd'),
    )).rejects.toMatchObject({ code: 'plugin_source_invalid' });
  });

  it('refuses a regular file at the receipt-directory path', async () => {
    const installed = await project();
    await mkdir(join(installed.root, '.relayflowd'));
    await writeFile(join(installed.root, '.relayflowd', 'hosted-extension-receipts'), 'not a directory\n');

    await expect(assertHostedDataDirectoryIsolated(
      installed.flowPath,
      join(installed.root, '.relayflowd'),
    )).rejects.toMatchObject({ code: 'plugin_source_invalid' });
  });

  it('refuses a dangling symlink at the receipt-directory path', async () => {
    const installed = await project();
    await mkdir(join(installed.root, '.relayflowd'));
    await symlink(
      join(installed.root, 'missing-receipt-target'),
      join(installed.root, '.relayflowd', 'hosted-extension-receipts'),
    );

    await expect(assertHostedDataDirectoryIsolated(
      installed.flowPath,
      join(installed.root, '.relayflowd'),
    )).rejects.toMatchObject({ code: 'plugin_source_invalid' });
  });
});
