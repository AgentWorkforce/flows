import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    // vitest defaults to 5s per test. That is fine on a laptop and too tight in
    // a cloud sandbox: run ae982aaa reported 22 failed / 166 passed, almost all
    // of them 'Test timed out in 5000ms', while the same commit runs 188/188
    // clean locally. Those phantom failures are expensive — they fail verify,
    // which marks the run VERIFY_FAIL_NONFATAL, and it then commits and opens a
    // PR carrying work that is actually fine but labelled broken.
    //
    // 30s is still short enough to catch a genuine hang. Cases that legitimately
    // need longer already declare it themselves (live-kernel uses 45s).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
