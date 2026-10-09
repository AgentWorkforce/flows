import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../', import.meta.url));
const policyPath = fileURLToPath(new URL('../standalone-policy.json', import.meta.url));
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

for (const name of ['babysitter-standalone', 'babysitter-fixer']) test(`the committed ${name} artifact is exact, reproducible, and asserts the enforced agent scope`, async () => {
  const artifactPath = fileURLToPath(new URL(`../artifacts/${name}.flow.ts`, import.meta.url));
  const manifestPath = fileURLToPath(new URL(`../artifacts/${name}.manifest.json`, import.meta.url));
  const [artifact, manifestBytes, policyBytes] = await Promise.all([
    readFile(artifactPath), readFile(manifestPath), readFile(policyPath),
  ]);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));

  assert.deepEqual(manifest, {
    schemaVersion: 1,
    artifact: `${name}.flow.ts`,
    bytes: artifact.byteLength,
    sha256: sha256(artifact),
    policy: '../standalone-policy.json',
    policySha256: sha256(policyBytes),
    runtime: { enforcedAgentWriteScope: true },
    requirements: {
      integrations: ['github'],
      harnesses: ['claude', 'codex'],
      mcp: [],
    },
    external: ['@relayflows/surface'],
  });
  assert.deepEqual(JSON.parse(policyBytes.toString('utf8')), {
    botLogin: 'agent-relay-code[bot]',
    label: 'babysit',
    reviewBots: [
      'chatgpt-codex-connector[bot]', 'coderabbitai[bot]', 'cubic-dev-ai[bot]', 'cursor[bot]', 'devin-ai-integration[bot]',
    ],
    ownAgents: ['AgentRelayBot'],
  });
  assert.match(artifact.toString('utf8'), /enforcedAgentWriteScope:\s*true/);

  const check = spawnSync(process.execPath, ['build-standalone.mjs', '--check'], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
  assert.ok(check.stdout.includes(`Checked ${name} sha256:${manifest.sha256}`), check.stdout);
});

test('scripts stringified into f.run never reach a bundler shim: `node -e` has no __require', async () => {
  for (const name of ['babysitter-standalone', 'babysitter-fixer']) {
    const artifact = await readFile(fileURLToPath(new URL(`../artifacts/${name}.flow.ts`, import.meta.url)), 'utf8');
    assert.doesNotMatch(artifact, /__require\(/, name);
  }
});
