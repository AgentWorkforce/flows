import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildFlow } from '../src/cli/build.js';

export const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'flows-deploy-'));
  await writeFile(join(root, 'flows.json'), '{}');
  await writeFile(join(root, 'hello.yaml'), 'version: 0.1.0\nname: hello\nsteps:\n  - id: greet\n    type: deterministic\n    command: echo deployed\n');
  const bundle = await buildFlow(join(root, 'hello.yaml'), join(root, 'dist/flows'), () => {});
  const reference = basename(bundle);
  const digest = reference.split('@sha256:')[1]!;
  const bucket = pathToFileURL(join(root, 'bucket')).href;
  const target = join(root, 'bucket/hello/sha256', digest);
  const invoke = (args: string[]) => spawnSync(process.execPath, [cli, ...args], {
    cwd: root, encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, XDG_CACHE_HOME: join(root, 'cache') },
  });
  return { root, bundle, reference, digest, bucket, target, invoke };
}
