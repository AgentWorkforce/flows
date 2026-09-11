# Spec G verification and handoff

This branch implements budget headers, frozen SDK pricing, per-completion spend,
and kernel admission limits. The lead approved adding two scenarios to the
existing exhaustive refusal test without changing its assertion, and preserving
legacy explicit-budget synthetic model behavior (Relay message
`224082264437923840`). The same message directs the worker to push and hand off
PR creation because fleet GitHub credentials return HTTP 401.

## Commands and captured output

Only trailing whitespace was normalized in the captured text logs for git.

From `kernel`:

```sh
PATH=/Users/khaliqgant/.cargo/bin:$PATH cargo test --workspace
```

Exit 0. Full literal output: [cargo-test.log](cargo-test.log). New integration
coverage output:

```text
running 3 tests
test daily_windows_reset_and_exact_limits_do_not_refuse ... ok
test crossing_completion_is_durable_and_next_step_is_refused ... ok
test deterministic_spend_and_wallclock_limit_gate_parallel_batch_starts ... ok
```

From `packages/sdk`:

```sh
PATH=/Users/khaliqgant/.cargo/bin:$PATH npm test
```

The full suite is not green on this host. Full output is retained in
[sdk-npm-test.log](sdk-npm-test.log):

```text
 Test Files  1 failed | 53 passed | 1 skipped (55)
      Tests  1 failed | 984 passed | 3 skipped (988)
```

The real analyzer requires a Claude login;
`claude auth status` returned exit 1; its full output is
[claude-auth-status.log](claude-auth-status.log).

An [earlier full run](sdk-npm-test-earlier.log) also failed the existing lease-wait timing assertion. The
entire CLI test file subsequently passed in the focused rerun below. Neither
assertion was modified and the analyzer was not skipped with an environment
flag.

```sh
PATH=/Users/khaliqgant/.cargo/bin:$PATH ./node_modules/.bin/vitest run tests/cli.test.ts tests/budget-preflight.test.ts tests/budget-attribution.test.ts tests/budget-authored-live.test.ts tests/preflight.test.ts
```

Final focused output: [sdk-focused.log](sdk-focused.log).

```text
 Test Files  5 passed (5)
      Tests  109 passed (109)
```

From `packages/surface`, `npm test` could not launch because `bun` is absent.
Its build, test typecheck, and test commands were run directly:

```sh
npm run build
./node_modules/.bin/tsc -p tsconfig.test.json
./node_modules/.bin/vitest run
```

All three exited 0; test output: [surface-test.log](surface-test.log).

```text
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

## Declarative smoke

The fixture `testdata/budget-guarded.flow.yaml` was compiled with the SDK's
`compileYaml` and `toKernelSpec` into `/tmp/spec-g-smoke.json`, then run from the
repository root:

```sh
kernel/target/debug/relayflowd --data-dir /tmp/spec-g-smoke-data run /tmp/spec-g-smoke.json
```

Exit 1 is the expected budget refusal. The emitted spec and captured outcome are
[smoke.spec.json](smoke.spec.json) and [smoke.log](smoke.log). The actual SQLite
journal excerpts are [smoke-journal.json](smoke-journal.json): `measured` completed
successfully with 19ms spend; `guarded` never started; the run completed with
`budget_exceeded`.

PR creation, CI checks and review-bot triage are handed to the lead. This evidence
does not claim required CI passed or that the branch is ready for merge.
