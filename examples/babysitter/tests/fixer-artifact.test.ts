import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../', import.meta.url));
const at = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

test('the committed fixer artifact is exact, reproducible, and asserts the enforced agent scope', async () => {
  const [artifact, manifestBytes, policyBytes] = await Promise.all([
    readFile(at('artifacts/babysitter-fixer.flow.ts')), readFile(at('artifacts/babysitter-fixer.manifest.json')), readFile(at('standalone-policy.json')),
  ]);
  assert.deepEqual(JSON.parse(manifestBytes.toString('utf8')), {
    schemaVersion: 1,
    artifact: 'babysitter-fixer.flow.ts',
    bytes: artifact.byteLength,
    sha256: sha256(artifact),
    policy: '../standalone-policy.json',
    policySha256: sha256(policyBytes),
    runtime: { enforcedAgentWriteScope: true },
    requirements: { integrations: ['github'], harnesses: ['claude', 'codex'], mcp: [] },
    external: ['@relayflows/surface'],
  });
  assert.match(artifact.toString('utf8'), /enforcedAgentWriteScope:\s*true/);
  const check = spawnSync(process.execPath, ['build-standalone.mjs', '--check'], { cwd: directory, encoding: 'utf8', timeout: 30_000 });
  assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
  assert.ok(check.stdout.includes(`Checked sha256:${sha256(artifact)} (babysitter-fixer)`), check.stdout);
});

test('scripts stringified into f.run never reach a bundler shim: `node -e` has no __require', async () => {
  for (const name of ['babysitter-standalone', 'babysitter-fixer']) {
    assert.doesNotMatch(await readFile(at(`artifacts/${name}.flow.ts`), 'utf8'), /__require\(/, name);
  }
});
