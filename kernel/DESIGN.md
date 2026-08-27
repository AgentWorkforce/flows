# relayflowd — Gate 1 kernel design

Scope: RFC-0001 gate 1 only — journal + memoization, resume without re-execution,
the hello ladder (deterministic / llm / agent), verification as control flow,
durable timers, leases, idempotency keys, durable streams, out-of-band step
completion. Nothing else. Vocabulary follows RFC §1 and Appendix A.

Ground rules inherited (not restated per section): append-only, fail-closed —
a journal write that fails fails the step; `completionReason` on every
completion; the kernel holds no provider SDKs; core has no I/O and runs on a
simulated clock; the journal replays **results, not code**.

---

## 1. Journal entry types

Every entry shares one envelope; `payload` is entry-type-specific canonical
JSON (sorted keys, no floats for money — dollars are decimal strings, tokens
are integers).

**Envelope (all entries):**

| field | type | notes |
|---|---|---|
| `seq` | int | journal-assigned, strictly monotone per run file |
| `segment_id` | int | == epoch number |
| `entry_type` | string | one of the types below |
| `run_id` | string | ULID |
| `step_id` | string \| null | null for run-level entries |
| `attempt` | int \| null | 1-based |
| `at_ms` | int | clock reading (simulated in core tests) |
| `payload` | object | below |

### 1.1 `run.spawned`
First entry of segment 1. Payload:
`spec` (full run-spec JSON, inlined — the journal is self-contained),
`spec_hash` (sha256), `parent_run_id` (null in gate 1), `journal_version`
(int, stamped per segment thereafter via `epoch.summary`), `created_by`
(client identity string).

### 1.2 `step.attempt.started`
One per attempt. Payload:

| field | notes |
|---|---|
| `step_type` | `deterministic` \| `llm` \| `agent` |
| `idempotency_key` | `sha256(run_id ‖ step_id)` — **stable across attempts** so effects dedupe per Appendix A rule 5 |
| `lease_id` | ULID |
| `lease_deadline_ms` | absolute; expiry ⇒ attempt is dead |
| `executor` | `kernel` (deterministic) \| worker id (llm/agent, dispatched) |
| `recovery_mode` | agent steps only: `reset` (default) \| `inspect` \| `manual` |
| `pins.workspace` | agent steps: `[{surface, revision_id}]` — relayfile revision id per declared mount surface, or `{worktree_base_commit}` |
| `pins.streams` | `[{stream, read_offset}]` — consumer offsets at attempt start |
| `max_iterations` | from spec, echoed for legibility |

Deterministic/llm steps journal `pins.streams` only if they consume streams;
`pins.workspace` is empty (no workspace).

### 1.3 `step.completed`
One per **attempt** (every completion, terminal or not, carries a reason).
Payload:

| field | notes |
|---|---|
| `completionReason` | `success` \| `verification_failed` \| `retries_exhausted` \| `lease_expired` \| `crashed` \| `timeout` \| `worker_error` \| `budget_exceeded` \| `canceled` |
| `disposition` | `step_done` \| `retry` \| `park` — `step_done` ends the step; `retry` schedules the next attempt; `park` ⇒ `needs_human` |
| `output` | JSON value — the memoized result (null unless `step_done`+`success`) |
| `verification` | `{gate, verdict: pass\|fail, detail}` or null |
| `end_pins` | agent steps: `{workspace: [{surface, revision_id}], streams: [{stream, read_offset}]}` — Appendix A rule 6: the next step's starting state **is** this |
| `effects` | list of `{surface_path, idempotency_key}` dedupe keys recorded this attempt |
| `budget` | `{tokens_in, tokens_out, dollars}` — exact; zero for memoized replay by construction (no entry is written on replay) |
| `completed_by` | `kernel` \| worker id — out-of-band completion uses the same entry, same discipline |
| `next_attempt_at_ms` | when `disposition=retry`: computed backoff+jitter wake time |

### 1.4 `wait.event`
Step parks on an external event. Payload: `wait_id` (ULID), `event_key`
(exact-match string in v0), `timeout_at_ms` (nullable).

### 1.5 `wait.human`
Durable human await. Payload: `wait_id`, `prompt` (what is being asked),
`requested_of` (identity string), `options` (nullable list),
`timeout_at_ms` (nullable), `diff_ref` (nullable — Appendix A `manual` mode:
pinned revision vs. current state).

### 1.6 `sleep.until`
Durable timer. Payload: `wait_id`, `wake_at_ms`, `reason` (free text:
`retry_backoff` \| `spec_sleep`).

### 1.7 `wait.completed`
Closes any of 1.4–1.6 (every completion carries a reason). Payload:
`wait_id`, `completionReason` (`event_received` \| `human_responded` \|
`timer_fired` \| `timeout` \| `canceled`), `result` (event/human payload,
null for timers).

### 1.8 `stream.appended`
Durable channel append — at-least-once, replayable. Payload: `stream`
(name), `offset` (0-based, dense per stream), `producer` (step_id or
identity), `message` (opaque JSON). Consumer offsets are not separate
entries: they are pinned in `step.attempt.started` / `step.completed` and
summarized per epoch.

### 1.9 `effect.recorded`
Appendix A rule 3: the mount write is the effect record. Payload:
`surface_path`, `idempotency_key`, `revision_before`, `revision_after`,
`agent_identity`, `deduped` (bool — true when a second attempt's write was
suppressed by the dedupe table and no provider call occurred).

### 1.10 `epoch.summary`
First entry of every segment after the first (decision #8). Resume reads
only the current segment, so this restates everything live. Payload:

| field | notes |
|---|---|
| `epoch` | int, == segment_id |
| `prev_segment_id` | int |
| `journal_version` | writers write only the newest |
| `steps_done` | `{step_id: {completionReason, output}}` — memoization survives compaction |
| `steps_open` | `{step_id: {attempt, state, lease_deadline_ms}}` |
| `open_waits` | restated 1.4–1.6 payloads keyed by `wait_id` |
| `stream_state` | `{stream: {length, consumers: {consumer_id: offset}}}` |
| `pinned_revisions` | `{surface: revision_id}` current chain head |
| `budget_spent` | `{tokens_in, tokens_out, dollars}` run total |

### 1.11 `segment.closed`
Last entry of a segment (so closing is an append, never an update). Payload:
`next_segment_id`.

### 1.12 `run.completed`
Terminal entry. Payload: `completionReason` (`success` \| `step_failed` \|
`canceled` \| `budget_exceeded`), `failed_step_id` (nullable),
`budget_total`.

---

## 2. SQLite schema

One SQLite file per run cell: `<data-dir>/runs/<run_id>.sqlite3`. A run's
entire durable state is this one file (decision #13: a sleeping run costs
storage only). A tiny registry `<data-dir>/relayflowd.sqlite3` maps
`run_id → file, status, next_wake_at_ms` so the binary can find due timers
without opening every run; it is an index, rebuildable from run files, never
authoritative.

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = FULL;      -- fsync on every commit; a failed commit fails the step

CREATE TABLE meta (              -- INSERT-only, written once at creation
  key   TEXT PRIMARY KEY,       -- 'run_id', 'created_at_ms', 'journal_version'
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE segments (          -- INSERT-only; one row appended per epoch
  segment_id      INTEGER PRIMARY KEY,   -- == epoch, 1-based
  journal_version INTEGER NOT NULL,
  opened_seq      INTEGER NOT NULL       -- seq of run.spawned / epoch.summary
);

CREATE TABLE entries (           -- the journal; INSERT-only, no UPDATE/DELETE ever
  seq        INTEGER PRIMARY KEY,        -- rowid alias; assigned monotonically
  segment_id INTEGER NOT NULL REFERENCES segments(segment_id),
  entry_type TEXT    NOT NULL,
  step_id    TEXT,
  attempt    INTEGER,
  at_ms      INTEGER NOT NULL,
  payload    TEXT    NOT NULL            -- canonical JSON
);
CREATE INDEX ix_entries_segment ON entries(segment_id, seq);
CREATE INDEX ix_entries_step    ON entries(step_id, seq) WHERE step_id IS NOT NULL;

CREATE TABLE effects (           -- Appendix A rule 5: dedupe at the mount boundary
  step_id         TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  surface_path    TEXT NOT NULL,
  entry_seq       INTEGER NOT NULL,      -- the effect.recorded entry that won
  PRIMARY KEY (step_id, idempotency_key, surface_path)
) WITHOUT ROWID;
-- INSERT OR IGNORE; a conflict means the effect already happened: suppress the
-- provider call and journal effect.recorded{deduped:true}.

CREATE TABLE stream_index (      -- INSERT-only projection of stream.appended
  stream    TEXT    NOT NULL,
  offset    INTEGER NOT NULL,
  entry_seq INTEGER NOT NULL,
  PRIMARY KEY (stream, offset)
) WITHOUT ROWID;
```

Append discipline: one transaction per logical append — `INSERT INTO
entries` plus any index-table inserts, then commit (fsync). If the commit
errors, `relayflowd-journal` returns `Err`, and core marks the step failed
with `completionReason` from the caller's context — never a warning, never a
fallback (AGENTS.md rule 4).

Segment-per-epoch: rollover appends `segment.closed`, inserts the new
`segments` row, and appends `epoch.summary` — all in one transaction. Closed
segments are contiguous `seq` ranges; they are never rewritten. Archival
(export of a closed range to relayhistory) is out of gate 1; the range query
`WHERE segment_id = ?` is the archival contract and exists now.

---

## 3. Step state machine (the hello ladder)

```
             deps met                 lease granted
  Pending ─────────────► Runnable ─────────────────► Running(attempt n)
                            ▲                            │
              timer fired   │                            ├─ output produced ──► Verifying
  Backoff ◄─────────────────┤                            ├─ wait declared ───► Waiting
     ▲    (sleep.until)     │                            └─ crash / lease expiry
     │                      │                                    │
     │   disposition=retry  │        wait.completed              ▼
     └── Verifying:fail ────┘   Waiting ────────────► Runnable   dead attempt:
         (n < max_iterations)                                    step.completed{crashed|lease_expired}
                                                                 then per recovery mode:
  Verifying ── pass ──► Done(success)                              retry → Backoff/Runnable
  Verifying ── fail, n = max_iterations ──► Done(retries_exhausted)  park  → NeedsHuman
  NeedsHuman ── wait.completed{human_responded} ──► Runnable | Done(canceled)
```

Journal mapping: `Runnable→Running` appends `step.attempt.started`; every
exit from `Running`/`Verifying` appends `step.completed` with the reason and
disposition; `Backoff` is a `sleep.until` + `wait.completed{timer_fired}`;
`Waiting`/`NeedsHuman` are `wait.event`/`wait.human` + `wait.completed`.
Verification is control flow, not decoration: the verdict picks the edge.

### Per rung

**Deterministic step.** Executed by the `relayflowd` binary (spawn command,
capture stdout/exit code). Output = `{exit_code, stdout_tail}`. Verification
v0: `exit_code == 0` plus optional `output_contains`. Gate-1 deterministic
steps are pure (the hello ladder), so a dead attempt simply retries; no pins.

**llm step.** No workspace, output is a value. The kernel never calls a
model: it dispatches the step to an attached SDK worker (§5), which makes
the call and returns `{output, usage}` via `step.complete`. The kernel then
runs the verification gate in-process — v0 gates are deterministic
(`output_contains`, `json_schema`) so verification is kernel-side and
replayable. Fail ⇒ `step.completed{verification_failed, retry}` with
backoff+jitter, bounded by `max_iterations` — semantic retry, the rail that
makes a prompt reliable. Each iteration's `usage` is charged to that
attempt's `budget` field.

**Agent step.** Dispatched to a worker like llm, plus Appendix A in full:
`step.attempt.started` pins declared workspace revisions and stream offsets
under the attempt's idempotency key; every writeback is a journaled
`effect.recorded` deduped by `(step_id, idempotency_key, surface_path)`;
`step.completed` pins end state, which defines the next step's start. Dead
attempt ⇒ recovery mode: `reset` restores pinned revisions and retries;
`inspect` retries inside the dirty workspace with the failed attempt's tail
injected; `manual` parks as `wait.human` with `diff_ref`.

### Memoized resume

`resume(run_id)` re-executes nothing that finished. Algorithm:

1. Open the run file; read the last `segments` row; scan entries of the
   current segment only (segment 1 starts from `run.spawned`, later segments
   from `epoch.summary`, which carries `steps_done` outputs forward).
2. Fold entries into a `RunState`: for each step, the latest
   `step.completed` with `disposition=step_done` makes it `Done` — its
   `output` is injected as fact, spending zero tokens and appending zero
   entries. Replay is results, not code.
3. A `step.attempt.started` with no matching `step.completed` is a dead
   attempt: append `step.completed{completionReason: crashed |
   lease_expired, disposition per retry policy/recovery mode}` — the journal
   explains both attempts (Appendix A rule 7c).
4. Open waits (`wait.*`/`sleep.until` without `wait.completed`) re-arm
   against the real clock and event router; elapsed timers fire immediately.
5. Stream lengths and consumer offsets rebuild from `epoch.summary` +
   subsequent `stream.appended` / pins — in-flight coordination survives
   `kill -9` like all other state.
6. Scheduling continues. Invariant (gate 1 done-when): total run spend ==
   Σ(budget of exactly one `success` completion per step), checkable because
   every token is journaled on exactly one attempt entry (decision #10).

---

## 4. Crate layout — `kernel/` cargo workspace

```
kernel/
├── Cargo.toml                # [workspace] members = core, journal, binary
├── DESIGN.md                 # this file
├── relayflowd-core/          # PURE: no I/O, no wall clock, no SQLite, no sockets
│   └── src/
│       ├── lib.rs
│       ├── spec.rs           # RunSpec, StepSpec{Deterministic,Llm,Agent}, VerificationSpec
│       ├── entry.rs          # §1 entry types (serde), completionReason enums
│       ├── state.rs          # RunState fold: Vec<Entry> → per-step states + memo table
│       ├── machine.rs        # §3 transitions: (RunState, Input, now_ms) → Vec<Action>
│       ├── retry.rs          # backoff + jitter; RNG seeded from idempotency_key (deterministic)
│       ├── verify.rs         # v0 gates: exit_code, output_contains, json_schema
│       ├── clock.rs          # trait Clock { fn now_ms(&self) -> i64 }; SimClock
│       └── journal.rs        # trait Journal { append, scan_segment, current_segment, … } — no impl
├── relayflowd-journal/       # SQLite impl of the Journal trait
│   └── src/
│       ├── lib.rs            # SqliteJournal: open/create per-run file, §2 schema
│       ├── append.rs         # single-transaction append, fsync, Err ⇒ fail the step
│       ├── segment.rs        # rollover: segment.closed + segments row + epoch.summary
│       └── registry.rs       # relayflowd.sqlite3 run index (rebuildable)
└── relayflowd/               # the binary
    └── src/
        ├── main.rs           # CLI: run <spec.json> | resume <run_id> | serve
        ├── engine.rs         # drives machine.rs Actions against journal + executors
        ├── exec_det.rs       # deterministic steps: spawn, capture, timeout
        ├── server.rs         # unix socket, protocol v0 (§5), worker dispatch
        └── clock.rs          # WallClock impl of core's Clock trait
```

Core is sans-I/O: `machine.rs` returns `Action`s (`Append(Entry)`,
`Dispatch{step, worker_class}`, `ExecDeterministic{step}`, `ArmTimer{at}`,
`CompleteRun{reason}`) and the binary interprets them. Everything in §3 —
including crash-resume and the exact-budget invariant — is testable in
`relayflowd-core` alone with `SimClock` and an in-memory `Journal`. The
crash-injection tests against the real binary + SQLite file (kill between
and during steps, resume, exactly-once effects) live in `relayflowd/tests/`
and are the gate.

Dependencies point one way: `relayflowd → {core, journal}`,
`journal → core`. Nothing in core names SQLite, tokio, or a socket.

---

## 5. Journal protocol v0 (SDK boundary)

Transport: newline-delimited JSON over a unix socket at
`<data-dir>/relayflowd.sock`. Requests `{id, verb, params}`; responses
`{id, ok: true, result}` or `{id, ok: false, error: {code, message}}`;
server-pushed events `{event, data}` (no `id`). Any verb whose journal
append fails returns `error{code: "journal_write_failed"}` and the affected
step fails — the protocol is fail-closed like everything behind it.

Minimal verb set for gate 1:

| verb | params → result | purpose |
|---|---|---|
| `hello` | `{protocol: 0, client}` → `{protocol: 0, server}` | handshake; version mismatch is a hard error |
| `run.start` | `{spec}` → `{run_id}` | validate spec (zero-agent flows are legal), create run file, append `run.spawned`, begin scheduling |
| `run.resume` | `{run_id}` → `{run_id, state}` | §3 memoized resume |
| `run.get` | `{run_id}` → `{status, steps, budget}` | snapshot for legibility |
| `run.watch` | `{run_id}` → stream of `{event: "entry", data: Entry}` | every appended entry, pushed |
| `worker.attach` | `{worker_id, step_types: ["llm","agent"]}` → `{}` | connection becomes a worker; receives `step.dispatch` events `{run_id, step_id, attempt, step_type, spec, idempotency_key, pins, lease_deadline_ms}` |
| `step.heartbeat` | `{run_id, step_id, attempt, lease_id}` → `{lease_deadline_ms}` | renew the lease; the one lease primitive |
| `step.complete` | `{run_id, step_id, attempt, idempotency_key, completionReason, output, usage, end_pins}` → `{}` | completes a dispatched step — **also the out-of-band path**: any worker holding the idempotency key may call it, journaled with the same discipline; kernel then runs verification and decides the edge |
| `event.emit` | `{run_id, event_key, payload}` → `{matched: n}` | satisfies `wait.event`; a human response arrives here too, closing `wait.human` with `completionReason: human_responded` |
| `stream.append` | `{run_id, stream, message}` → `{offset}` | durable channel write; journals `stream.appended` |
| `stream.read` | `{run_id, stream, from_offset, limit}` → `{messages, next_offset}` | at-least-once replayable read; committing the consumer offset happens via the reader's step pins, not a verb |
| `journal.read` | `{run_id, from_seq, limit}` → `{entries}` | raw journal access — replay, audit, the report step |

Not in v0 (deliberately): triggers/subscriptions (gate 2), persona anything
(gate 2), memory verbs (gate 5), mounts as a protocol concern (gate 6 —
gate 1 agent-step pins take revision ids as opaque strings from the worker),
placement (gate 7), identity/credential resolution (gate 8 — `worker_id`
and `agent_identity` are plain strings for now).

---

## Gate-1 acceptance mapping

- Hello ladder (a): `run.start` with a spec of only deterministic steps —
  legal, runs in the binary alone.
- Ladder (b): + one `llm` step with an `output_contains` gate — dispatch,
  semantic retry, memoized value.
- Ladder (c): + one `agent` step — pins, `reset` recovery, effect dedupe.
- `kill -9` at every boundary and mid-step, then `run.resume`: completed
  steps replay as results; budget equals one execution of each step; the
  journal explains every attempt via `completionReason`.
