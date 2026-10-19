// Replica of Cloud's hosted Surface materialization (AgentWorkforce/cloud
// packages/core/src/bootstrap/lib/relayflow-v2-executor.ts,
// materializeRelayflowV2SurfacePackage, at cloud main 5b31e1016: the
// supportedExports shape check ~3988-4024 and the Bun compatibility envelope
// ~4040-4092). `withSignals: false` is Cloud as shipped; `withSignals: true`
// is the companion change `@relayflows/surface/signals` needs.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LEGACY_EXPORTS = {
  '.': { types: './dist/index.d.ts', import: './dist/index.js', require: './dist/index.js' },
  './runtime': { types: './dist/runtime.d.ts', import: './dist/runtime.js', require: './dist/runtime.js' },
  './triggers': { types: './dist/triggers/index.d.ts', import: './dist/triggers/index.js', require: './dist/triggers/index.js' },
  './triggers/*': { types: './dist/triggers/*.d.ts', import: './dist/triggers/*.js', require: './dist/triggers/*.js' },
};
const SIGNALS_EXPORT = {
  './signals': { types: './dist/signals.d.ts', import: './dist/signals.js', require: './dist/signals.js' },
};

export interface EnvelopeOptions { withSignals: boolean }

/** Cloud's exact-match export check; `false` is Cloud's "unsupported export shape" refusal. */
export function cloudAcceptsSurfaceManifest(manifest: Record<string, unknown>, options: EnvelopeOptions): boolean {
  const shapes = [LEGACY_EXPORTS, ...(options.withSignals ? [{ ...LEGACY_EXPORTS, ...SIGNALS_EXPORT }] : [])];
  return manifest.type === 'module' && manifest.main === './dist/index.js'
    && shapes.some(shape => JSON.stringify(manifest.exports) === JSON.stringify(shape));
}

/** Rewrites an installed Surface in place the way Cloud does before the authored body loads. */
export function applyCloudSurfaceEnvelope(packageRoot: string, options: EnvelopeOptions): void {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Record<string, unknown>;
  const hasSignals = options.withSignals
    && Object.hasOwn(manifest.exports as Record<string, unknown>, './signals');
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    private: true,
    type: 'module',
    types: './index.d.ts',
    exports: {
      '.': './index.js',
      './runtime': './runtime.js',
      './triggers': './triggers/index.js',
      './triggers/*': './triggers/*.js',
      ...(hasSignals ? { './signals': './signals.js' } : {}),
    },
  }));
  writeFileSync(join(packageRoot, 'index.js'), "export * from './dist/index.js';\n", { flag: 'wx' });
  writeFileSync(join(packageRoot, 'runtime.js'), "export { getFlowDefinition } from './dist/flow.js';\n", { flag: 'wx' });
  writeFileSync(join(packageRoot, 'index.d.ts'), "export * from './dist/index.js';\n", { flag: 'wx' });
  writeFileSync(join(packageRoot, 'runtime.d.ts'), "export { getFlowDefinition } from './dist/flow.js';\n", { flag: 'wx' });
  if (hasSignals) {
    writeFileSync(join(packageRoot, 'signals.js'), "export * from './dist/signals.js';\n", { flag: 'wx' });
    writeFileSync(join(packageRoot, 'signals.d.ts'), "export * from './dist/signals.js';\n", { flag: 'wx' });
  }
  mkdirSync(join(packageRoot, 'triggers'));
  for (const entry of readdirSync(join(packageRoot, 'dist/triggers')).filter(name => /^[a-z0-9-]+\.js$/u.test(name)).sort()) {
    writeFileSync(join(packageRoot, 'triggers', entry), `export * from '../dist/triggers/${entry}';\n`, { flag: 'wx' });
    writeFileSync(join(packageRoot, 'triggers', entry.replace(/\.js$/u, '.d.ts')),
      `export * from '../dist/triggers/${entry}';\n`, { flag: 'wx' });
  }
}
