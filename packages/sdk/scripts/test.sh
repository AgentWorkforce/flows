#!/bin/sh
set -eu

trap 'node scripts/prune-test-build.mjs' EXIT

npm run test:prep
npm run typecheck
npm run build
npm run typecheck:tests
# The packaging gate calls npm pack on this SDK. With npm 10, pack still runs
# prepare even with --ignore-scripts, rebuilding dist while other test files
# execute the built CLI. Keep the full gate, but run it after those readers.
vitest run --exclude tests/cli-package-gate.test.ts
vitest run tests/cli-package-gate.test.ts
