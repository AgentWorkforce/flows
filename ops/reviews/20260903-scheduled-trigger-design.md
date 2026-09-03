# Scheduled triggers: a relayflow can be scheduled

2026-09-03 · branch `feat/scheduled-trigger-0903` · base `origin/main` `990093b`

A relayflow could not be scheduled. `grep -rniE "cron|schedule|interval|timer"`
over `sdk/src/spec.ts` and `sdk/src/compile.ts` returned nothing; every shipped
trigger is fed by a poller reacting to something external (`hn-poller.ts`,
`dir-watcher-poller.ts`); `agent-relay cloud schedules` reports "No workflow
schedules found." "Run this flow every ten minutes" had no expression anywhere
in the authoring dialect.

This PR builds that primitive. **No Rust changed.**

---

## 1. The shape, and why

RFC-0001 had already decided it, so the work was to follow the decision rather
than make one:

- gate 2 "**proves: triggers are entry conditions, not schedulers**";
- the first dogfood run, 2026-08-27: "a cron trigger reported `succeeded` into
  a void with no worker enrolled" — a scheduler *inside* the kernel is exactly
  what produced that;
- "the trigger plane is **liveness-checked** … **because a flow that is never
  triggered is silently zero — Native's silent-death problem**."

So a schedule is an **event source**, not a kernel feature. There is no `cron:`
field on the spec. `sdk/src/tick-source.ts` sits beside the directory watcher
and the HN poller, submits `flows.tick` through the same `event.submit` path
every other source uses, and thereby inherits — rather than reimplements — the
kernel's dedupe claim and its liveness sweep.

The kernel learns about time the way it learns about everything else: as an
event.

### The slot grid

Time is divided into fixed slots anchored at a declared `epochMs`:

```
slot(t)           = floor((t - epochMs) / intervalMs)
scheduledForMs(n) = epochMs + n * intervalMs
```

A slot is an interval **of the grid**, not the moment a poller happened to wake
up. That distinction is the whole design: `scheduledForMs` is a pure function of
the grid, so one scheduled instant has one identity no matter when — or how many
times — a poller notices it.

Payload of one tick:

```json
{"schedule_id":"heartbeat-1m","slot":29400001,"scheduled_for_ms":1764000060000,
 "interval_ms":60000,"emitted_at_ms":1764000257000,"lag_ms":197000}
```

`lag_ms` exists so a backfilled run can tell that it is running for a slot from
the past rather than for now.

### Why `intervalMs` and not cron syntax

Not a shortcut — a boundary. A cron expression is a *surface* concern
(RFC settled decision 13: "the kernel vocabulary is closed; the surface is
open"). `TickSchedule` is the primitive a cron parser would compile *to*: any
expression that can name a sequence of instants can drive `emitDueTicks`.
Shipping a parser now would have been the speculative abstraction AGENTS.md §6
forbids. Not built, deliberately.

---

## 2. Dedupe by construction

**Duplicates and skips are two different failure modes with two different
mechanisms, and neither covers for the other.** Getting that split right is what
makes the primitive honest.

### Duplicates — the dedupe key

The key is derived from `(schedule_id, scheduled_for_ms)` through the flow's
declared template:

```
dedupeKeyTemplate: '{{event.type}}:{{payload.schedule_id}}:{{payload.scheduled_for_ms}}'
```

`scheduled_for_ms` — **not** `emitted_at_ms`, which is carried in the payload for
observability and deliberately excluded from the key. The kernel then applies its
existing `(flow_key, subscription_id, dedupe_key)` claim
(`kernel/relayflowd-journal/src/registry.rs`), so the second delivery of a slot
returns `deduped: true, run: null` and creates no journal.

This one mechanism covers every duplicate shape:

| Scenario | Why it is idempotent |
|---|---|
| Double-fire inside one slot | Both emissions derive the same key |
| Two pollers racing | Same grid, same key, kernel claim picks one |
| Re-delivery of an old tick | Key is a function of the slot, not of now |
| **Poller restart with a lost cursor** | Re-emitting slot N derives N's key again |

The last row is the important one: **restart-idempotency belongs to the dedupe
key, not to the cursor.** A caller that never persists the cursor still cannot
double-run a slot. It only loses backfill.

### Skips — the cursor

`emitDueTicks` emits **every** slot between the last one it emitted and now, not
just the current one. A poller asleep across three slots backfills three ticks
into three distinct runs rather than silently dropping two.

The cursor advances **only after a successful submit**, exactly as
`pollDirectoryOnce` adds to its `seen` set only after a successful submit. A
journal failure mid-backfill leaves the remaining slots due, so the next poll
retries them. The cursor is a plain JSON object owned by the caller, precisely so
a caller that wants restart-safe backfill can persist it.

### The catch-up bound

A poller down for a week on a one-minute schedule has ~10,000 outstanding slots.
Replaying all of them is a stampede, not a recovery. `maxCatchUp` (default 60)
caps one poll's backfill to the **newest** slots — the current slot's work is the
relevant work, the oldest is the most stale.

Slots beyond the bound are **returned in `skippedSlots`**, not dropped quietly.
They are returned rather than thrown so a week-long outage recovers to the
current slot instead of wedging, and returned rather than ignored so the skip
cannot be silent (AGENTS.md §4, fail closed / no silent fallbacks). The cursor
advances past them so each skip is reported exactly once instead of forever.

---

## 3. Liveness — what is guaranteed, and what is not

### What I provide

The kernel **already has** a full trigger-liveness plane and I did not need to
build one — `kernel/relayflowd/src/server/liveness.rs` implements exactly the
RelayCron deterministic-id claim + `stale_after` reconciliation the RFC names
(`sweep_claims` single-winner bucket election, `detect_stale` → journal → latch
ordering, CAS-guarded latch, at-least-once-per-silence).

What was missing was the **authoring half**. The kernel's `TriggerSpec` has
carried `stale_after_ms` all along, but the SDK's `TriggerSpec`, `TRIGGER_KEYS`
and `KernelTriggerSpec` did not, so **a flow author could not declare a silence
budget through the supported path**. Every flow silently inherited the 5-minute
engine default — a decision no author made.

This PR adds `staleAfterMs` to the authoring dialect, validates it against the
same i64 bound the kernel enforces (`TriggerSpec::effective_stale_after_ms`), and
`testdata/tick-heartbeat.flow.yaml` declares three slots' worth of it.

Observed end to end against a real daemon (§5.3): a tick schedule that stops
firing produces a journaled `subscription.stale` entry **and** a greppable
stderr line naming the flow, the subscription, the last event time and the
budget. "This schedule last fired at T" is recorded in the `subscriptions` table
by every successful match, deduped or not.

### What I did NOT do — stated plainly

1. **Provisioned-but-never-fired is still undetected.** A schedule whose source
   never submits a single tick has no `subscriptions` row and no `event_dedupe`
   row, so the sweep sees nothing. This is the kernel's own documented "Known
   gap" (`server/liveness.rs`), it predates this PR, and closing it means
   pre-registering spec triggers at spec-observation time — a kernel change,
   which this PR is scoped out of. **A tick source that dies after firing at
   least once is detected; one that never starts is not.**
2. **Nothing restarts a dead schedule.** Detection is journaled and logged; the
   sweep does not re-provision, page, or escalate. The observable hook is left,
   the action is not built.
3. **No `flows tick start` CLI.** `emitDueTicks` is a pure function of
   `(schedule, cursor, now)` — the timer that calls it is the caller's. Adding a
   `flows tick` subcommand alongside `flows hn-monitor start` is the obvious next
   rung and is outside the four items I was given. Consequence: nothing in-repo
   currently *runs* a schedule continuously, so `agent-relay cloud schedules`
   will still report nothing after this merges. **This PR builds the primitive
   and proves it; it does not put a schedule into production.**

---

## 4. The unavoidable defect I had to fix first

`toKernelSpec` did **not** lower trigger keys to the kernel dialect. It spread
`flow.triggers` through untouched, so every event subscription reached the kernel
in camelCase — and `relayflowd`'s `TriggerSpec` is `#[serde(deny_unknown_fields)]`
over snake_case. Captured, against the committed fixture, on **unmodified
`origin/main`**:

```
$ node -e "... compileYamlToCanonicalJson(testdata/event-triggered-flow.yaml) ..."
SDK canonical: ...,"triggers":[{"dedupeKeyTemplate":"{{event.type}}:{{payload.message}}","eventType":"test.ping",...}],...
fixture      : ...,"triggers":[{"dedupe_key_template":"{{event.type}}:{{payload.message}}","event_type":"test.ping",...}],...

$ relayflowd --data-dir $D run $D/sdk-compiled.json
Error: parse run spec /tmp/tickproof.3ndq/sdk-compiled.json

Caused by:
    malformed run spec: unknown field `dedupeKeyTemplate`, expected one of `id`, `executor`, `event_type`, `pattern`, `dedupe_key_template`, `stale_after_ms`

$ relayflowd --data-dir $D2 run testdata/event-triggered-flow.spec.canonical.json
{"run_id":"01M1KJGFDKCYS08H53QQ39Z1E3","status":"parked","completion_reason":null,"completed_steps":0}
```

**Every event-triggered flow in `testdata/` was unauthorable through the
supported SDK path.** It went unnoticed because the committed
`*.spec.canonical.json` fixtures are snake_case (kernel-produced or hand-written)
and `spec-parity.test.ts` only exercised the four `hello-*` fixtures, none of
which has a trigger.

This was unavoidable for item 4, which requires the tick fixtures be generated
**through the SDK compiler**. It is SDK-side, not kernel-side. The fix is
`toKernelTrigger` / `kernelTriggerToAuthoring` in `sdk/src/compile.ts`.

The strongest evidence it is correct: the fixed compiler now reproduces the
pre-existing snake_case fixtures **byte-for-byte** — those fixtures were the
kernel's truth all along, and the compiler simply was not producing them:

```
event-triggered-flow.yaml MATCHES committed fixture
hn-monitor.flow.yaml MATCHES committed fixture
```

`spec-parity.test.ts` now pins all three (plus the new tick fixture) so this
cannot silently regress again.

`sdk/src/spec.ts`'s `TriggerSpec` also said "Inert gate-1 trigger declaration"
with only `id` and `executor` while three shipped specs used `eventType`,
`pattern` and `dedupeKeyTemplate`. It now describes what actually ships.

---

## 5. The worked example, run for real

`testdata/tick-heartbeat.flow.yaml` + `.spec.canonical.json` + `.spec.sha256`,
following `hn-monitor` and `dir-watcher` exactly. Both fixtures generated through
`compileYamlToCanonicalJson` / `compileAndHash` from `sdk/dist/compile.js` — never
by hand. `spec_hash` = `0c3d089f0075c53442c5c2241ada734af5e450a2b558c16030aaf1d1e29127ff`.

`testdata/preflight/tick-slot-report-cli` is the step's agent CLI, modelled on
`wake-context-probe-cli`: it reads the tick out of `$RELAYFLOW_WAKE_CONTEXT` and
emits the JSON the flow's `json_schema` gate requires. Deterministic on purpose —
the subject under test is the trigger plane, not a model.

### 5.1 A real run: four backfilled slots → four runs, then a deduped re-delivery

Poller asleep across slots 29400001–29400003, wakes 17s into 29400004; then a
second poller re-delivers 29400004 with a lost cursor.

```
$ relayflowd --data-dir /tmp/tickdemo.kTUR serve &
$ node /tmp/tick-worked-example.mjs /tmp/tickdemo.kTUR

emittedSlots: [29400001,29400002,29400003,29400004]
skippedSlots: []
  slot 29400001 -> matched=true deduped=false run=01M1KK6XV9M5DMJQH3V7HPK8AJ
  slot 29400002 -> matched=true deduped=false run=01M1KK6XVJT7CMM7T5H5SZSXYA
  slot 29400003 -> matched=true deduped=false run=01M1KK6XVR8TTFQ7JH5KKEG7V3
  slot 29400004 -> matched=true deduped=false run=01M1KK6XVYTT6N791BWEX8D1FH
replay of slot 29400004: matched=true deduped=true run=null
run 01M1KK6XV9M5DMJQH3V7HPK8AJ slot 29400001: reason=success output={"lag_ms":197000,"schedule_id":"heartbeat-1m","scheduled_for_ms":1764000060000,"slot":29400001}
run 01M1KK6XVJT7CMM7T5H5SZSXYA slot 29400002: reason=success output={"lag_ms":137000,"schedule_id":"heartbeat-1m","scheduled_for_ms":1764000120000,"slot":29400002}
run 01M1KK6XVR8TTFQ7JH5KKEG7V3 slot 29400003: reason=success output={"lag_ms":77000,"schedule_id":"heartbeat-1m","scheduled_for_ms":1764000180000,"slot":29400003}
run 01M1KK6XVYTT6N791BWEX8D1FH slot 29400004: reason=success output={"lag_ms":17000,"schedule_id":"heartbeat-1m","scheduled_for_ms":1764000240000,"slot":29400004}
```

Four missed slots produced four distinct successful runs, each reporting its own
grid instant and its own lag; the re-delivery produced **zero**. The script is
reproduced in §7 so this is re-runnable.

### 5.2 The dedupe identity in the kernel's own journal

`event_key` is the scheduled instant, not the emit time:

```
subscription.matched {"event_key":"flows.tick:heartbeat-1m:1764000000000","subscription_id":"every-minute", ...
  "triggering_event":{"payload":{"emitted_at_ms":1764000000000,"interval_ms":60000,"lag_ms":0,
  "schedule_id":"heartbeat-1m","scheduled_for_ms":1764000000000,"slot":29400000},"type":"flows.tick"}}
```

### 5.3 The liveness sweep firing for a tick schedule

Same flow with `staleAfterMs: 1000`, one tick submitted, then silence. Daemon
stderr:

```
relayflowd: subscription.stale flow="b356ed314641457efb46f578b5f3ae23a0ff819a95a0573a8bf881115ee2a79b" sub="every-minute" event_type="flows.tick" last_event_at_ms=1788437770130 stale_after_ms=1000 detected_at_ms=1788437791447
```

And the journal for that run:

```
subscription.registered {"effective_stale_after_ms":1000,"event_type":"flows.tick","executor":"agent-worker","subscription_id":"every-minute"}
subscription.matched    {"event_key":"flows.tick:heartbeat-1m:1764000000000","subscription_id":"every-minute", ...}
subscription.stale      {"detected_at_ms":1788437791447,"event_type":"flows.tick","flow_key":"b356ed31...","last_event_at_ms":1788437770130,"stale_after_ms":1000,"subscription_id":"every-minute"}
```

`effective_stale_after_ms: 1000` is the flow's **declared** budget, not the
5-minute engine default — which is what proves `staleAfterMs` survives the
authoring → kernel lowering.

---

## 6. Gates

Baseline measured on the worktree **before any edit**, at `origin/main`
`990093b`. `RELAYFLOWD_BIN` pinned for every SDK run to
`/Users/khaliqgant/.relayflows-toolchain/target/173824371/debug/relayflowd`
— this worktree's own build (`173824371` is `cksum` of this worktree's path).
Pinned because `locateRelayflowd` otherwise picks the newest daemon by mtime
across every worktree's target tree.

| Gate | Baseline (`990093b`) | Head |
|---|---|---|
| `tsc --noEmit` | exit 0 | exit 0 |
| `tsc -p tsconfig.tests.json` | exit 0 | exit 0 |
| `vitest run` | 370 passed, 3 skipped, **0 failed** | 408 passed, 3 skipped, **0 failed** |
| `cargo test --workspace` | 100 passed, 0 failed | 100 passed, 0 failed |

> The first baseline attempt reported 12 failures. Those were an artifact of not
> having run `test:prep` — no `sdk/dist`, no built kernel, no chmod on
> `testdata/preflight/*-cli`. After the documented prep the baseline is clean, and
> that clean run is the one compared above.

### Per-file test accounting (set-diff, not counts)

```
+6  sdk/tests/live-kernel.test.ts  (21 -> 27)
+6  sdk/tests/spec-parity.test.ts  (15 -> 21)
+6  sdk/tests/validate.test.ts     (36 -> 42)
+20 sdk/tests/tick-source.test.ts  (0 -> 20)
    total 373 -> 411   (370 passed + 3 skipped -> 408 passed + 3 skipped)
```

Full-name set-diff: **38 test names added, 0 removed, 0 renamed.**
`git diff --stat sdk/tests/live-kernel.test.ts` is `200 ++++` with **zero
deletions** — the new block is a pure insertion, no existing case touched.

Kernel: `diff` of the sorted `test … ok` line set between baseline and head is
empty — **identical kernel test set**, consistent with no Rust changing.

### Not trusting green CI

flows CI runs only `linux-x64-artifact` and `packed-consumer`; neither the
kernel nor the SDK suite. Everything above is local output.

---

## 7. Mutation verification

Both mutations: reverted the specific behaviour, ran the specific tests,
captured the failure, restored **byte-for-byte** (`sha256(tick-source.ts)` =
`3edce9029eb6e679ad539b413e2d0251bf3f0cd4a6848b5eea7c00fdc8e87b5e` before and
after both), re-ran, captured the pass.

### M1 — dedupe key from wall clock instead of the scheduled instant

`scheduled_for_ms: scheduledFor` → `scheduled_for_ms: nowMs`. Ticks still fire;
only the *bound* is removed.

```
× tick source: a double-fire produces ONE run > two emissions of one scheduled instant claim the same key, so one run
  → expected 'flows.tick:heartbeat-1m:6000001' to be 'flows.tick:heartbeat-1m:6000000'
× tick source: a double-fire produces ONE run > a poller RESTART that loses its cursor re-emits the slot but does not re-run it
  → expected 'flows.tick:heartbeat-1m:6005000' to be 'flows.tick:heartbeat-1m:6000000'
× a relayflow can be scheduled: ... > TWO ticks for ONE scheduled instant produce exactly ONE run
  → the kernel spawned a second run for one scheduled instant: expected { deduped: false, matched: true, …(2) } to match object { matched: true, deduped: true, …(1) }
Tests  3 failed | 1 passed | 43 skipped (47)
```

The third line is the one that matters: a **real relayflowd** spawned a second
run for one scheduled instant. Restored → `Tests 4 passed | 43 skipped`.

### M2 — backfill removed (emit only the current slot)

```
× backfills every slot a sleeping poller passed over          → expected [ 104 ] to deeply equal [ 101, 102, 103, 104 ]
× a backfilled tick carries its own lag ...                   → expected [ +0 ] to deeply equal [ 120000, 60000, +0 ]
× does NOT advance past a slot whose submit failed ...        → promise resolved "{ emittedSlots: [ 104 ], …(2) }" instead of rejecting
× reports slots dropped by the catch-up bound ...             → expected [ 110 ] to deeply equal [ 108, 109, 110 ]
× reports each skipped slot exactly once ...                  → expected [] to deeply equal [ 101, 102, 103, 104 ]
× caps at DEFAULT_MAX_CATCH_UP ...                            → expected [ 500 ] to have a length of 60 but got 1
× emits nothing when the current slot has already been emitted → expected [ 100 ] to deeply equal []
× emits nothing when the clock moves backwards ...            → expected [ 90 ] to deeply equal []
× a MISSED interval is backfilled into its own run ...        → expected [ 29400004 ] to deeply equal [ 29400001, 29400002, 29400003, …(1) ]
Tests  9 failed | 38 passed (47)
```

Restored → `tests/tick-source.test.ts (20 tests) ✓`,
`tests/live-kernel.test.ts (27 tests) ✓`, `Tests 47 passed (47)`.

### The tests are bounds, not mechanisms

Deliberately **not** written: "a tick fired". That passes under M1 and would
have shipped a schedule that double-runs every slot. What is pinned instead:

- two ticks for one scheduled instant → **one** run (live kernel);
- a poller restart re-emitting a slot → **no** second run (live kernel);
- successive slots are **not** deduped away — the mirror test, without which a
  constant key would pass everything above and the flow would run once, ever;
- four missed slots → **four distinct** runs, not one collapsed run;
- a failed submit does **not** advance the cursor past its slot;
- slots beyond the catch-up bound are **reported**, exactly once;
- a tick for a different `schedule_id` **does not wake** the flow;
- the journal carries the **declared** budget, not the engine default.

---

## 8. Reproducing §5.1

```js
// /tmp/tick-worked-example.mjs — node /tmp/tick-worked-example.mjs <dataDir>
import { readFileSync } from 'node:fs';
const SDK = '<worktree>/sdk/dist', ROOT = '<worktree>';
const { JournalClient } = await import(`${SDK}/journal-client.js`);
const { AgentWorker }   = await import(`${SDK}/worker.js`);
const { emitDueTicks }  = await import(`${SDK}/tick-source.js`);

const dataDir = process.argv[2];
const spec = JSON.parse(readFileSync(`${ROOT}/testdata/tick-heartbeat.spec.canonical.json`, 'utf8'));
for (const s of spec.steps) if (s.id === 'report-slot') s.cli = `${ROOT}/testdata/preflight/tick-slot-report-cli`;

const client = new JournalClient(`${dataDir}/relayflowd.sock`, { requestTimeoutMs: 5000 });
await client.connect(); await client.hello('tick-worked-example');
const worker = new AgentWorker(client, { workerId: 'tick-worked-example-worker',
  pins: { workspace: [{ surface: 'repo', revision_id: 'rev-a' }], streams: [] } });
await worker.attach();

const schedule = { scheduleId: 'heartbeat-1m', intervalMs: 60_000, epochMs: 0 };
const cursor = { lastEmittedSlot: 29_400_000 };
const nowMs = 29_400_004 * 60_000 + 17_000;           // asleep 3 slots, wakes 17s into 29400004
const result = await emitDueTicks(spec, client, { schedule, cursor, nowMs });
const replay = await emitDueTicks(spec, client, { schedule, cursor: {}, nowMs: nowMs + 9_000 });
// ... print result.emittedSlots / outcomes, then journalRead each run's step.completed
```

---

## 9. What I could not verify

- **Provisioned-but-never-fired liveness.** Not attempted; it needs a kernel
  change (§3). The failure mode remains open exactly as
  `server/liveness.rs` documents it.
- **A schedule running in production.** No CLI runner ships here, so
  `agent-relay cloud schedules` will still report "No workflow schedules found"
  after this merges. The primitive is proven; it is not deployed.
- **Behaviour across a daemon restart mid-backfill.** The unit test covers a
  failed submit mid-backfill with a fake sink; I did not kill a live daemon
  between two slots of one backfill. The dedupe claim is durable in SQLite so I
  expect it to hold, but I did not observe it and am not claiming it.
- **Clock skew between two hosts running the same schedule.** Two pollers on the
  same grid dedupe correctly (proved), but I did not test hosts whose clocks
  disagree by more than one interval — that would put them in different slots
  and produce two runs. Real, unaddressed, out of scope here.
- **`maxCatchUp = 60` as the right default.** Chosen as an hour of one-minute
  slots. Not empirically justified.
- **`hn-monitor.flow.yaml` round-trip** through `kernelToAuthoring(toKernelSpec(…))`
  differs under `JSON.stringify` but is equal under `toEqual` — key ordering only,
  in the `output` → `verification` sugar, unrelated to triggers and unchanged by
  this PR.
