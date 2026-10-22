import { createRequire } from 'node:module';
import { mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Cached single-file flows use the CLI's installed authoring runtime. */
export async function prepareCachedFlowRuntime(directory: string): Promise<void> {
  const require = createRequire(import.meta.url);
  const packages = [
    ['@relayflows/surface', require.resolve('@relayflows/surface/runtime')],
    ['@relayflows/sdk', fileURLToPath(import.meta.url)],
  ] as const;
  for (const [name, entry] of packages) {
    let root = dirname(entry);
    for (;;) {
      const manifest = await readFile(join(root, 'package.json'), 'utf8').catch(() => '{}');
      if ((JSON.parse(manifest) as { name?: string }).name === name) break;
      const parent = dirname(root);
      if (parent === root) throw new Error(`Cannot locate installed ${name}.`);
      root = parent;
    }
    const target = join(directory, 'node_modules', name);
    await mkdir(dirname(target), { recursive: true });
    try { await symlink(root, target, 'dir'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await realpath(target) !== await realpath(root)) {
        throw new Error(`Cached runtime at ${target} differs from this CLI. Remove that link and retry.`);
      }
    }
  }
}
