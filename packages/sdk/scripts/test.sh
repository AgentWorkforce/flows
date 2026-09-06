#!/bin/sh
set -eu

trap 'node scripts/prune-test-build.mjs' EXIT

npm run test:prep
npm run typecheck
npm run build
npm run typecheck:tests
vitest run
