import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { fixture } from './deploy-fixture.js';

// Opt in with the same real-kernel override used by existing SDK live tests.
it.skipIf(!process.env['RELAYFLOWD_BIN'] || !existsSync(process.env['RELAYFLOWD_BIN']))(
  'executes a deployed digest on the real kernel after deleting the authoring tree', async () => {
    const f = await fixture(); const data = join(f.root, 'data');
    try {
      expect(f.invoke(['deploy', f.reference, '--to', f.bucket]).status).toBe(0);
      await rm(join(f.root, 'dist'), { recursive: true }); await rm(join(f.root, 'hello.yaml'));
      const result = f.invoke(['run', f.reference, '--bucket', f.bucket, '--data-dir', data,
        '--no-observer-link', '--json']);
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ completionReason: 'success', completedSteps: 1 });
    } finally {
      try {
        const connection = JSON.parse(await readFile(join(data, 'connection.json'), 'utf8'));
        process.kill(connection.pid, 'SIGTERM');
      } catch { /* No spawned daemon if preflight refused. */ }
      await rm(f.root, { recursive: true, force: true });
    }
  }, 30_000,
);
