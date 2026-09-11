import { afterEach, describe, expect, it } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseDigestReference } from '../src/bundle-transport.js';
import { buildFlow } from '../src/cli/build.js';
import { fixture } from './deploy-fixture.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('digest references', () => {
  it.each(['hello', 'Hello', 'hello.world', 'hello_world', '123', 'A_b.c-1'])(
    'accepts and deploys the build output for %s', async name => {
      const f = await fixture(); roots.push(f.root);
      await writeFile(join(f.root, 'named.yaml'), `version: 0.1.0\nname: ${JSON.stringify(name)}\nsteps:\n  - id: greet\n    type: deterministic\n    command: echo deployed\n`);
      const bundle = await buildFlow(join(f.root, 'named.yaml'), join(f.root, 'dist/flows'), () => {});
      const reference = basename(bundle);
      expect(parseDigestReference(reference)).toEqual({ name, digest: reference.split('@sha256:')[1] });
      const result = f.invoke(['deploy', reference, '--to', f.bucket]);
      expect(result.status, result.stderr).toBe(0);
    },
  );
  it.each(['', '.', '..', '../hello', '/hello', 'a/b', 'a\\b', '@hello', '-hello', 'hello world'])(
    'rejects unsafe name %j', name => {
      expect(parseDigestReference(`${name}@sha256:${'a'.repeat(64)}`)).toBeUndefined();
    },
  );
  it.each(['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64)])(
    'rejects malformed digest %s', digest => {
      expect(parseDigestReference(`hello@sha256:${digest}`)).toBeUndefined();
    },
  );
});
