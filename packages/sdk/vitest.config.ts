import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The relay CLI-surface contract package, linked dev-only for the surface
 * conformance and drift tests.
 *
 * Not a package.json devDependency on purpose: npm records a `file:` /  `..`
 * location in package-lock.json, which `checkInstalledVersions` in
 * bundle-typescript.ts refuses, breaking every standalone TS bundle build.
 * Aliasing it here (and via `paths` in tsconfig.tests.json) gives the tests the
 * real `assertSurfaceConforms` / `walkCommands` implementations while leaving
 * both the lockfile and the published package untouched.
 */
const CLI_SURFACE = fileURLToPath(
  new URL('../../../relay/packages/cli-surface/dist/index.js', import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: { '@agent-relay/cli-surface': CLI_SURFACE },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});
