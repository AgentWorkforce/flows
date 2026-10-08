// Produce the exact, reviewable source Cloud may launch. The policy contains
// no credentials; both it and the enforced runtime contract are covered by
// the committed artifact digest.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from '../../packages/sdk/node_modules/esbuild/lib/main.js';

const args = process.argv.slice(2);
const check = args.length === 1 && args[0] === '--check';
if (args.length > 0 && !check) {
  throw new Error('Usage: node examples/babysitter/build-standalone.mjs [--check]');
}

const root = fileURLToPath(new URL('.', import.meta.url));
const artifactDirectory = fileURLToPath(new URL('artifacts/', import.meta.url));
const artifactPath = fileURLToPath(new URL('artifacts/babysitter-standalone.flow.ts', import.meta.url));
const manifestPath = fileURLToPath(new URL('artifacts/babysitter-standalone.manifest.json', import.meta.url));
const policyPath = fileURLToPath(new URL('standalone-policy.json', import.meta.url));
const policyBytes = await readFile(policyPath);
const policy = JSON.parse(policyBytes.toString('utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const result = await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "import { createStandaloneBabysitter } from './standalone.ts';",
      `export default createStandaloneBabysitter(${JSON.stringify(policy)}, { enforcedAgentWriteScope: true });`,
      '',
    ].join('\n'),
    resolveDir: root,
    sourcefile: 'standalone-entry.ts',
    loader: 'ts',
  },
  outfile: artifactPath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@relayflows/surface'],
  // readSignals/postComment/githubRead.toString() execute inside f.run; keep their identifiers.
  minify: false,
  write: false,
});
const artifact = result.outputFiles?.find(file => file.path === artifactPath)?.contents;
if (!artifact) throw new Error('Standalone build produced no artifact.');
const manifest = Buffer.from(`${JSON.stringify({
  schemaVersion: 1,
  artifact: 'babysitter-standalone.flow.ts',
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
}, null, 2)}\n`);

if (check) {
  const [committedArtifact, committedManifest] = await Promise.all([
    readFile(artifactPath), readFile(manifestPath),
  ]);
  if (!committedArtifact.equals(artifact) || !committedManifest.equals(manifest)) {
    throw new Error('Committed standalone artifact drifted; run build-standalone.mjs and commit both generated files.');
  }
  process.stdout.write(`Checked sha256:${sha256(artifact)}\n`);
} else {
  await mkdir(artifactDirectory, { recursive: true });
  await Promise.all([
    writeFile(artifactPath, artifact),
    writeFile(manifestPath, manifest),
  ]);
  process.stdout.write(`Built ${artifactPath} sha256:${sha256(artifact)}\n`);
}
