# NEXT — single highest-priority work package

Written by the Relayflow Lead on 2026-08-27 (tick on branch
`flow/drive-9f07ffc-08270827`, HEAD = `9f07ffc`, identical to `main`).

## Assessment snapshot (evidence)

- **Current gate: gate 1** (RFC-0001 §3). Its done-when does not yet hold:
  the hello ladder must survive `kill -9` at *every* step boundary and
  between them for rungs (a)/(b)/(c); today only rung (a) exists and its
  crash harness covers one chosen kill point, not a sweep.
- **Open PRs: none** (`gh pr list --state open` → empty). Nothing is
  awaiting review fixes, so new work is legitimate.
- **Tests at assessment time (2026-08-27):**
  - `kernel/`: `cargo test --workspace` → **32 passed, 0 failed**
    (run with `CARGO_HOME=/tmp/flows-cargo-home` — see environment note).
  - `sdk/`: `npm test` → **50 passed, 0 failed** (grown from the bootstrap
    report's 41; validate and journal-client suites have expanded).
- **Environment defect, still live:** `~/.cargo/registry` is a broken
  symlink to an unmounted volume ("Paris Drive"). Any cargo command using
  the default CARGO_HOME fails, which also breaks the workflow's own
  `kernel-tests` deterministic step. Must be neutralized repo-locally.
- Source of priority: `docs/bootstrap-report.md` §"Next three work
  packages", WP-1, which this package adopts.

## Work package: WP-1 — close ladder rung (a)

**Exhaustive crash harness + budget exactness for the pure deterministic
hello flow, and a repo-local cargo home so the test gate runs without
hand-applied workarounds.**

### Objective

Make gate-1 rung (a) *done per the RFC*, not demonstrated once: the pure
deterministic hello flow survives `kill -9` at every step boundary and
mid-step, resumes via the real binary's `resume` CLI completing only
unfinished work, replays results not code, and the resumed run's token/
budget accounting equals exactly one execution of each step. Also survives
kill while running under `serve`. Fold in the three minor review
observations from the bootstrap report so no known debt carries into
rung (b).

### Files in scope

- `kernel/relayflowd/tests/crash_resume.rs` (extend: kill-point sweep,
  resume-via-binary-CLI in the SIGKILL case, kill-under-`serve`, budget
  exactness assertion)
- `kernel/relayflowd/src/` (only as needed to support the above — e.g.
  exposing budget totals via `run.get`/journal read; no new step kinds)
- `kernel/relayflowd-core/src/` and `kernel/relayflowd-journal/src/`
  (only if the sweep exposes real defects; fixes must come with a pinned
  regression test)
- `sdk/src/journal-client.ts` (+ its test) — type `runStart`'s param as the
  kernel dialect, not the authoring `FlowSpec` (review observation 1)
- `kernel/relayflowd-core/src/machine.rs` (or wherever `next_actions`
  lives) — return timers for *all* backing-off steps, not just the first in
  spec order (review observation 2), with a test
- `sdk/.gitignore` / repo `.gitignore` + removal of `sdk/dist/` from the
  index (review observation 3 — drift-prone build artifacts)
- `kernel/.cargo/config.toml` (new) or an `ops/` env script +
  `workflows/bootstrap-gate1.yaml` — pin a repo-local/deterministic
  `CARGO_HOME` so cargo works on this machine despite the broken
  `~/.cargo/registry` symlink; document it in `kernel/README` or the
  workflow file

### Definition of done

All of the following commands pass from a clean checkout **without any
manually exported environment variables**:

```sh
cd kernel && cargo test --workspace            # all green, incl. new sweep tests
cd kernel && cargo clippy --workspace -- -D warnings
cd kernel && cargo fmt --check
cd sdk && npm test                             # tsc --noEmit && vitest run, all green
```

And the new tests prove, against the **real `relayflowd` binary** (spawned
process, not in-process engine):

1. **Kill-point sweep:** SIGKILL delivered at every step boundary of the
   hello flow (before step 1, between each pair of steps, after the last
   step's effect but before run completion) *and* mid-step for at least one
   long-running step. Parameterized/looped, not one hand-picked point.
2. **Resume via the binary:** every resumed case goes through
   `relayflowd resume` (the CLI), asserting completed steps are not
   re-executed (exactly-once effects, memoized outputs replayed).
3. **Kill under `serve`:** a run started through the `serve` socket
   survives SIGKILL of the server process and resumes correctly.
4. **Budget exactness:** after any kill/resume cycle, the run's recorded
   spend equals one execution of each step — asserted from the journal,
   not from process-local state.
5. Dead attempts are journaled with an explained `completionReason`
   (`crashed | lease_expired`), never silently replaced.

### Out of scope for this tick

- **Rung (b) — the `llm` step** and the missing protocol verbs
  (`worker.attach`, `step.heartbeat`, `step.complete`, `run.watch`,
  `stream.*`, `event.emit`). That is WP-2.
- **Rung (c) — the `agent` step and Appendix A pins** (surfaces,
  pin-on-start, `reset`/`inspect`/`manual` recovery, mount-boundary
  dedupe). That is WP-3.
- Durable channels, out-of-band completion, `flows check` preflight, the
  failure-taxonomy closure — later rungs/gates.
- Gates 2–9 entirely; no consumer migration work.
- Fixing the `~/.cargo/registry` symlink itself (mounting "Paris Drive" or
  relocating the cache is a human/machine decision) — we only make the
  repo immune to it.
- Any RFC or charter edits.

### Delivery

One PR against `main` from a `flow/` branch. The Lead does not merge;
report test evidence in the PR body and await human review (per
charter hard rails).

ASSESS_DONE
