import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { applyCloudSurfaceEnvelope, cloudAcceptsSurfaceManifest } from './fixtures/cloud-surface-envelope.js';

// Runs against the built package (`bun run test` builds first), the payload
// Cloud copies next to hosted flow source.
const surfaceRoot = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(surfaceRoot, 'package.json'), 'utf8')) as Record<string, unknown>;
const legacyManifest = { ...manifest, exports: Object.fromEntries(
  Object.entries(manifest.exports as Record<string, unknown>).filter(([key]) => key !== './signals')) };
const directories: string[] = [];
afterAll(() => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); });

const consumer = `
globalThis.fetch = async (url, init) => {
  console.log('URL ' + url);
  console.log('AUTH ' + new Headers(init.headers).get('authorization'));
  return Response.json({ payload: { done: true }, acceptedAt: 1 });
};
let signals;
try { signals = await import('@relayflows/surface/signals'); }
catch (error) { console.log('IMPORT_FAILED ' + (error.code ?? error.name) + ' ' + error.message); process.exit(0); }
const { getFlowDefinition } = await import('@relayflows/surface/runtime');
if (typeof getFlowDefinition !== 'function') throw new Error('runtime export lost');
console.log('PAYLOAD ' + JSON.stringify(await signals.waitForSignal('native_done')));
`;

const fixtures = new Map<string, { directory: string; packageRoot: string }>();
function hostedSource(withSignals: boolean, packageManifest = manifest) {
  const key = `${withSignals}:${packageManifest === manifest}`;
  const existing = fixtures.get(key);
  if (existing) return existing;
  const directory = mkdtempSync(join(tmpdir(), 'surface-signals-envelope-'));
  directories.push(directory);
  const packageRoot = join(directory, 'node_modules/@relayflows/surface');
  mkdirSync(packageRoot, { recursive: true });
  cpSync(join(surfaceRoot, 'dist'), join(packageRoot, 'dist'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify(packageManifest));
  applyCloudSurfaceEnvelope(packageRoot, { withSignals });
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  writeFileSync(join(directory, 'consumer.mjs'), consumer);
  fixtures.set(key, { directory, packageRoot });
  return { directory, packageRoot };
}

function run(command: string, directory: string) {
  const result = spawnSync(command, ['consumer.mjs'], {
    cwd: directory, encoding: 'utf8', timeout: 30_000,
    env: { PATH: process.env['PATH'], RELAYFLOW_V2_CLOUD_RUN_ID: 'cloud-run-1',
      RELAYFLOW_V2_SIGNAL_READ_TOKEN: 'hosted-read', RELAYFLOW_RUN_ID: 'engine-run' },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

const runtimes = [['node', process.execPath] as const,
  ...(spawnSync('bun', ['--version']).status === 0 ? [['bun', 'bun'] as const] : [])];

// Each fixture copies the built dist and spawns a runtime; slow disks need headroom.
describe("Cloud's hosted Surface envelope and @relayflows/surface/signals", { timeout: 120_000 }, () => {
  it('publishes ./signals, so Cloud as shipped refuses this manifest before the envelope', () => {
    expect(Object.keys(manifest.exports as object)).toEqual(['.', './runtime', './triggers', './triggers/*', './signals']);
    expect(existsSync(join(surfaceRoot, 'dist/signals.js'))).toBe(true);
    // relayflow-v2-executor.ts: "Relayflow v2 authored Surface package has an unsupported export shape".
    expect(cloudAcceptsSurfaceManifest(manifest, { withSignals: false })).toBe(false);
    expect(cloudAcceptsSurfaceManifest(legacyManifest, { withSignals: false })).toBe(true);
  });

  it.each(runtimes)('the shipped envelope does not export ./signals to the authored body (%s)', (_name, command) => {
    const { directory } = hostedSource(false);
    expect(run(command, directory)).toContain('IMPORT_FAILED');
  });

  it.each(runtimes)('the companion envelope resolves ./signals with hosted defaults (%s)', (_name, command) => {
    expect(cloudAcceptsSurfaceManifest(manifest, { withSignals: true })).toBe(true);
    const { directory } = hostedSource(true);
    const output = run(command, directory);
    expect(output).toContain('URL https://agentrelay.com/cloud/api/v1/workflows/runs/cloud-run-1/signals/native_done?waitMs=25000');
    expect(output).toContain('AUTH Bearer hosted-read');
    expect(output).toContain('PAYLOAD {"done":true}');
  });

  it('the companion envelope keeps a pre-signals Surface byte-identical', () => {
    expect(cloudAcceptsSurfaceManifest(legacyManifest, { withSignals: true })).toBe(true);
    const shipped = hostedSource(false, legacyManifest);
    const companion = hostedSource(true, legacyManifest);
    expect(readFileSync(join(companion.packageRoot, 'package.json'), 'utf8'))
      .toBe(readFileSync(join(shipped.packageRoot, 'package.json'), 'utf8'));
    expect(existsSync(join(companion.packageRoot, 'signals.js'))).toBe(false);
  });
});
