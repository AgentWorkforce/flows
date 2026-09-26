# PR #501 review follow-up — `manual` recovery for worker-reported transport loss

Review-swarm history lens and Cursor Bugbot both found the same defect in
`f3bd47fe`: `completion_actions` retried every budget-eligible `crashed` /
`lease_expired` completion without reading the agent step's `recovery_mode`.
Only the kernel-noticed death (`abandonment_actions`) honoured `manual`, so
the same dead attempt parked or redispatched depending on who noticed it
first — contradicting RFC-0001 Appendix A rule 4.

## What changed

1. **`completion_actions` parks a `manual` agent step on a worker-reported
   `crashed` / `lease_expired`** (`Disposition::Park` + `wait.human`), for any
   transport budget including zero. The `wait.human` construction is one
   function, `recovery::manual_park_wait`, shared with `abandonment_actions`
   so the two producers cannot drift. `completion_actions` gained a
   `start_pins` parameter so the `diff_ref` is anchored on the journaled
   start pin, never the worker's `end_pins` claim.
2. **Torn parks are repaired on resume.** A park is two appends, each its own
   transaction (raised by the independent reviewer, confirmed by external
   probe). A step folded to the placeholder `park-<step>-<attempt>`
   (`state::park_placeholder_wait_id`) with no `wait.human` after it now has
   the wait journaled by `recovery_actions_filtered` — once, from the same
   journaled facts. This closes the same latent gap on the pre-existing
   abandonment path.
3. **`all_backing_off_steps_return_timers`** regained a retryable failure
   precondition (`Crashed`; `worker_error` is terminal since the budget
   split) so it exercises failure backoff again.
4. **`step.attempt.started.max_transport_retries` is always journaled**
   (`entry.rs` dropped `skip_serializing_if = is_zero_u32`). `kernel/DESIGN.md`
   said "omitted at default (1)"; the code omitted zero — the one value that
   explains why a lost process was not retried. Now it matches its sibling
   `max_iterations`: always present. DESIGN.md updated, plus a paragraph tying
   the SDK classifier, the completion-reason alphabet and the kernel
   disposition together.

## Evidence (literal commands + full output)

| file | what |
|---|---|
| `mutation-transcript.txt` | one literal transcript, every command echoed: pre-mutation `sha256sum` of `machine.rs` + `recovery.rs`; mutation A+B applied (`manual_park = false && …`, repair guard `false && …`, shown as `git diff -U0`); RED — 5 regression tests fail with the original symptom (`disposition: retry`, second dispatch); restore via `cp` and `sha256sum -c` → `OK` for both files; mutation B alone (repair off); RED — the two torn-park tests fail (0 `wait.human` where 1 expected); restore + `sha256sum -c` → `OK`; GREEN — same commands pass |
| `green-kernel.txt` | `cargo test --workspace`, exit 0 |
| `clippy.txt` | `cargo clippy --workspace --all-targets -- -D warnings`: exits 101 on pre-existing findings only (`schema.rs:125`, `spec.rs:77`, `memoization.rs:102` as in the PR body, plus pre-existing test-target findings); `clippy-all-targets-warn.txt` lists every warning location — none on lines this change added |
| `sdk-typecheck-build.txt` | surface built + packed + installed `--no-save` into sdk (documented flow), then `npm run typecheck && npm run typecheck:tests && npm run build`, exit 0 |
| `green-sdk.txt` | `RELAYFLOWD_BIN=<built relayflowd> npx vitest run`: 154 files / 2410 tests pass; 2 environmental failures explained below |
| `green-sdk-bundle-pristine.txt` | `tests/bundle.test.ts` re-run from a pristine `npm ci`: 23/23 pass, exit 0 |
| `green-sdk-authored-node-runtime.txt` | the standalone suite under an isolated `mise install bun@1.4.0` (global config untouched) + Node 22.23.2 via `mise exec`, `FLOWS_BUILD_BUN` / `FLOWS_AUTHORED_NODE` absolute: 14/14 pass, exit 0 |
| `codex-live-probe.txt` | one bounded live run of the installed `codex-cli 0.154.0` through the direct unattended transport (`flows check` + `flows run --local-agent`, output-only instruction, disposable cwd verified unchanged): `success`, exit 0, verified output, journal facts incl. the transport evidence. First attempt refused by the kernel on `cwd` — pre-existing preflight/run mismatch, see below |


Pre-existing defect observed while probing (not fixed here, out of scope):
`flows check` accepts a step-level `cwd:` (compiled into the kernel spec since
#358) but `relayflowd` rejects the spec at `run.start` with
`invalid_spec: unknown field "cwd"` — a Covenant 2 preflight/run mismatch.

The two failures in `green-sdk.txt` are environmental, not from this change:

- `tests/bundle.test.ts` — `REFUSED [bundle_invalid] package-lock.json:
  node_modules/@agent-relay/cli-surface does not match its pinned version`.
  The documented `--no-save` surface override resolved `cli-surface` to
  12.4.0 over the lockfile's 12.2.4; the bundle builder refuses a non-pristine
  tree by design. Green from a pristine `npm ci` (file above).
- `tests/authored-node-runtime.test.ts` — `beforeAll` pins `bun --version`
  to exactly `1.4.0`; this machine has 1.4.2. The PR body excluded this
  standalone suite for a different toolchain reason (node flag).

Regression tests added:

- `relayflowd-core/src/machine/recovery_tests.rs` (focused module; owner asked
  for it split out of the general `tests.rs`):
  `manual_recovery_parks_a_worker_reported_transport_loss_instead_of_redispatching`
  (crashed + lease_expired), `reset_recovery_still_retries_a_worker_reported_transport_loss`,
  `recovery_journals_the_wait_human_a_torn_manual_park_never_wrote` (both producers)
- `relayflowd-core/src/machine/tests.rs`: `all_backing_off_steps_return_timers`
  precondition restored (stays in the general file)
- `relayflowd-core/src/entry.rs`: `max_transport_retries_is_always_journaled`,
  `a_pre_field_attempt_started_still_reads`
- `relayflowd/tests/manual_recovery.rs` (in-process engine, mock worker):
  park survives reopen + resume with no redispatch and answers to a human on
  the pinned revision (crashed / lease_expired / budget 0); crash injected
  between the park's two appends is repaired on resume, idempotently
- `relayflowd/tests/crash_resume/manual_recovery.rs` (real `relayflowd serve`
  binary over the protocol socket): same three cases, silence probe for
  `step.dispatch`, daemon SIGKILL + restart + `resume`, journal unchanged,
  `event.emit` answer redispatches attempt 2 on `rev-0` with the same
  idempotency key

`rustfmt --check` drift is unchanged from the PR head (20 files, none touched
by this change beyond formatting the lines it added).

Captured logs are verbatim except that trailing whitespace on captured lines
was stripped (`sed 's/[ \t]*$//'`) so `git diff --check` passes; no other
byte was edited.
