# NEXT — WP-13: Fix SDK test failures from sandbox environment gaps

Date: 2026-08-28. Written by Relayflow Lead assessment.

## Objective

Restore SDK tests to passing state by fixing test execution failures caused by sandbox environment gaps. The SDK test suite shows 19 failures out of 150 tests, with failures concentrated in `cli.test.ts` (17 failures) and `bin.test.ts` (2 failures). All failures stem from missing executables that tests expect to exist.

Gate 1 is GREEN per ops/STATE.md. No open PRs exist. Gate 6 (integrations via relayfile) is the strategic next gate, but **this work package addresses a prerequisite blocker**: SDK tests are failing, which indicates the test infrastructure is broken. A broken test suite cannot verify gate 6 work.

## Files in scope

- `sdk/tests/cli.test.ts` — 17 failures, all related to missing CLI executables
- `sdk/tests/bin.test.ts` — 2 failures, same root cause
- `sdk/tests/live-kernel.test.ts` — 7 tests skipped due to missing kernel binary
- `testdata/preflight/authenticated-cli` — expected by tests but missing or non-executable
- `testdata/preflight/counting-cli` — expected by tests but missing
- `kernel/target/debug/relayflowd` — expected by live-kernel tests but not built

The failures fall into two categories:

1. **Preflight test fixtures are missing or non-executable** — tests expect `testdata/preflight/authenticated-cli` and `counting-cli` to exist and be executable, but they don't exist or lack executable permission
2. **Kernel binary is not built** — `live-kernel.test.ts` expects `/project/workflows/runs/62a07fa4-5ef8-4cdc-8b45-acfa23587000/kernel/target/debug/relayflowd` but it doesn't exist

## Definition of done

The following commands must pass with zero failures:

```bash
cd /project/workflows/runs/62a07fa4-5ef8-4cdc-8b45-acfa23587000/sdk
npm test
```

Expected output: All test suites pass, 150 tests pass, 0 failures.

Specifically:
- `tests/cli.test.ts`: 50 tests pass (currently 17 failing)
- `tests/bin.test.ts`: 7 tests pass (currently 2 failing)
- `tests/live-kernel.test.ts`: 7 tests run and pass (currently 7 skipped)
- All other test suites maintain their passing state

The fix must work in both local and cloud sandbox environments per the BACKLOG requirement: "a fix that only works in one is the defect it replaces."

## What is explicitly OUT of scope

- **Gate 6 integration work** — this work package does NOT implement gate 6 features. It only fixes the broken test infrastructure that would prevent us from verifying gate 6 work.
- **New test coverage** — we are fixing existing tests, not adding new ones
- **Kernel implementation work** — we are not extending kernel functionality, only ensuring the binary is built for tests that need it
- **Refactoring test structure** — maintain the existing test architecture
- **SDK API changes** — no changes to the SDK's public interface
- **Test performance optimization** — focus is on correctness, not speed

## Context

From ops/STATE.md: Gate 1 is GREEN, merged at main@e48631d. Gate 6 is next up. No open PRs exist.

From ops/HANDOFF-2026-08-28.md: The laptop was closed with tick 18 stopped deliberately. Gate 1 is confirmed GREEN. Two cloud verify gaps were fixed in 97dd723.

From ops/BACKLOG.md: Cloud sandbox verify gaps include "The executable bit does not survive the snapshot upload" and "sdk/node_modules is absent." The verify step must install (npm ci) when node_modules is missing.

The test failures observed here match the known cloud sandbox environment issues. The fixes must ensure tests pass in both environments.
