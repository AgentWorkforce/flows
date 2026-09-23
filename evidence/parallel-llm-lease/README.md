# Diagnosis evidence: concurrent `f.llm` dispatched after its lease expired

Backs `plan.md` at the repo root. This directory records how the reported
failure was **reproduced and localized before the fix**, not how the fix was
verified. Post-fix commands and captured outputs live in
[../parallel-llm-fix/README.md](../parallel-llm-fix/README.md).

## Harness

`diagnosis-harness.test.ts` is a throwaway vitest file that was run from
`packages/sdk/tests/` and then removed. It is kept here verbatim so the
numbers below can be reproduced: copy it back to
`packages/sdk/tests/zz-scratch-repro.test.ts` and run the commands recorded in
each transcript.

It builds on the existing `chainFixture` (`packages/sdk/tests/flow-chain-fixture.ts`),
which starts a real `relayflowd`, attaches a real `AgentWorker` + `LlmWorker`,
and points `flows.json` at a fake wrapper CLI. The only change is that the fake
CLI's **preflight probe branches** (`--relayflows-adapter-v1` identification and
`auth status`) log every invocation with a timestamp, and the `auth` branch
sleeps `SCRATCH_PROBE_MS`. Step *execution* is untouched and fast.

Preconditions: `cd kernel && sh ../ops/cargo.sh build` and `npm run build` in
`packages/sdk`.

## What each transcript shows

### `probe-count-capacity1.txt` — the repeated work

`SCRATCH_PROBE_MS=0`, 9 concurrent `f.llm`, capacity 1. The run succeeds, and
the probe log holds:

    "probeCount": 27,
    "byKind": { "identify": 18, "auth": 9 }

18 of those 27 are preflight (9 identification + 9 `auth status`); the other 9
identifications are the steps actually executing. One preflight probe round per
`f.llm` call, all of it `spawnSync`.

### `lease-expired-capacity1.txt` — the consequence

Same flow, `SCRATCH_PROBE_MS=4000`. The run fails:

    "elapsedMs": 36694,
    "failure": "step_failed: journal step \"llm-1\" completed with lease_expired"

    Error: Agent lease is already expired for 01M36BDH5G5CAFP4YVVW6BZ2MY/llm-1.
     ❯ armExpiry src/worker-lease.ts:20:13
     ❯ Module.withWorkerLease src/worker-lease.ts:47:5
     ❯ LlmWorker.execute src/llm-worker.ts:60:46
     ❯ JournalClient.onDispatch src/llm-worker.ts:49:26

Same error string and same stack as the issue report. Elapsed ≈ 9 × 4 s: the
event loop spent the whole run inside `spawnSync`. `llm-1` — the *first* call,
the only one that ever held a lease at capacity 1 — is the attempt that expired.

### `lease-expired-capacity4.txt` — capacity is not the variable

Identical run at the default capacity 4: same failure, same step, elapsed
36801 ms. The probe train runs *before* `WorkerSlots.run` is ever reached, so
admission capacity cannot bound it. This is why the issue reproduces at
`--agent-capacity 4` and `1` alike.
