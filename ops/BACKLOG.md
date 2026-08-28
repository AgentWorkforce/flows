# Backlog — durable, below directives

Items the Lead should weigh in assess after ops/DIRECTIVES.md and the current
gate's needs. Not commitments; ordering is the Lead's call with evidence.

- **Close the deterministic-command preflight gap (Codex P1).** Refuse a
  path-like deterministic command word (contains `/`) when that path does not
  exist, while retaining the warning for bare words that may be shell builtins,
  functions, or assignments. Filed from PR #8; deliberately not implemented
  in WP-4-FIX.
- **Release pipeline (relay pattern, NOT crates.io):** cross-compile
  `relayflowd` per platform in CI, bundle binaries into the npm `flows`
  CLI/SDK + curl installer for self-host cells (see `../relay`
  `.github/workflows/publish.yml` — binary matrix shipped inside the npm
  package; no `cargo publish`). Reserve crate names on crates.io as a
  squatting hedge only. Needed before gate 2/3 consumers run on the kernel.
- **Persist review transcripts:** the review step's verdict currently leaves
  no evidence artifact (only the gating token). Capture review output to
  ops/ per tick until the kernel journal owns it.
- **Re-register cloud schedules from current drive.yaml** once a worker
  exists (registered bytes lag main), and delete stale schedule c8b6b7d0.
- **Customer harness is a named design partner** (`sales/harness` — authored on
  flows v2): its filed requirements rank gate work. First expected asks:
  `on()` triggers (gate 2), slack/notion helpers (gate 6), `f.human` channel
  delivery (covenant 3), memory scopes (gate 5).
- **PR titles from the pr step** leak the NEXT.md markdown header — use the
  work-package name.
- **The PR-shepherd flow (Garden component, gate 3):** when the Garden opens
  a PR, spawn a bounded-lifetime flow subscribed via relayfile to THAT PR
  only: `on(github.pr(N).review | .comment | .ci)` — each wake gets the
  original work-package requirements (ops/NEXT.md at PR time) + the new
  feedback in context, addresses findings from external reviewers (codex bot)
  and the relayflow review swarm (hoopsheet pattern), pushes fixes, replies,
  and closes itself at merge. The flow IS the PR's lifecycle. Khaliq,
  2026-08-27 — natural first real consumer of `on()` + relayfile PR trees.
- **Regression suite (`regressions/`, dormant):** red/green flow pairs for the
  four platform bugs found 2026-08-27 — enrollment-token bearer auth
  (cloud#3202), the `--daemon` `$bunfs` argv re-exec, RelayCron's `succeeded`
  into a void (covenant 2), and the cross-account 404 rendered as a permissions
  error (covenant 1). Written in the v2 dialect against a surface that does not
  exist yet; nothing runs until gates 1/2/6/7/8 close per `regressions/MANIFEST.json`.
  The Garden should adopt them once flows run in cloud.
- **`f.browser` helper (gate-6 family, plugin-shaped).** Escape hatch for the
  long tail: SaaS with no API, customer portals, vendor dashboards — what the
  50 relayfile adapters will never cover. Backed by the existing
  `browser-primitive` (kept deliberately by the 0825 charter). Ships under the
  plugin contract: compiles to kernel primitives, declares its preflight. NOT
  needed for the regression suite — asserting UI strings is brittle and tests
  the symptom; assert at the API where the condition is known.
- **Computer use — deferred, behind heavier rails.** Browser automation covers
  ~95%; desktop control adds native apps and installers. Highest-blast-radius
  primitive we could ship: unscoped clicking defeats path-scoped permissions
  (`workspace: readonly` means nothing if an agent can click Delete in a GUI).
  Needs per-run browser profile, no shared cookie jar, screen-region and app
  allowlists, and every action journaled as an effect before it is covenant-2
  compliant.
- **Upstream issues (2026-08-27):** cloud#3202 (bearer-auth enrolment,
  cross-account 404 messaging, cron-succeeded-into-void) · relay#1620
  (`--daemon` $bunfs argv crash + `worker status` blind to cloud liveness).
  Executable acceptance: `regressions/` on main.
- **Cloud sandbox runs die in `sync`: no git remote.** With the Relaycast 500
  cleared, cloud launches now provision a sandbox and execute the flow, then
  fail at `drive.yaml`'s first step: `fatal: 'origin' does not appear to be a
  git repository` (runs 9fc8d996, ff35187a, 06505b94 — 2026-08-27). The flow
  assumes a checkout with a remote, which holds locally and not in a fresh
  sandbox. Fix is flows-side: materialize the repo into the sandbox (relayfile
  github mount, as the personas do) or make `sync` clone when `origin` is
  absent. This is the last known gap between local ticks and machine-
  independent scheduled execution.
- **Documented `steps: []` check/kernel asymmetry (P3, WP-4 review V3).** The
  authoring surface refuses an empty step list —
  `REFUSED [invalid_spec] spec.steps: expected a non-empty array`, exit 2 —
  while the kernel accepts it: `RunSpec.steps` is `#[serde(default)]`
  (`kernel/relayflowd-core/src/spec.rs`, `RunSpec::steps`) and
  `RunSpec::validate` has no
  empty-steps check, so the loops no-op and it returns `Ok(())`. Same false-red
  class as the WP-5 F1 `name` case, and degenerate (a zero-step flow is
  meaningless; refusing it at authoring is defensible), so it was raised
  non-blocking. Close it by either refusing empty steps in the kernel too, or
  noting in `docs/SURFACE.md` that the authoring surface deliberately narrows
  this case. Deliberately not fixed in WP-5: the kernel option is out of scope.
- **Scope the `flows check` CLI probe environment (gate 8; WP-7 F6).** Gate 1
  intentionally discloses that `<cli> auth status` inherits the checker's
  complete caller environment. Gate 8 must replace ambient inheritance with
  an explicit scoped or allowlisted probe environment before untrusted or
  self-authored flow specs are checked under privileged credentials.

## Carried from PR #8 at squash (2026-08-28)

Eight findings stood open in the final passing transcript
(`ops/reviews/20260827-2331-pr8-maintainability.md`) and were not carried into
this ledger when #8 merged; the DRIVE-LOG called its three-item residual list
complete. Recorded here so they are tracked rather than lost — found by tick
12's reviewer (F4), which is exactly the kind of drop a squash makes invisible.

- **F1** — `probeFailedMessage`'s fall-through asserts *"timed out"* about any
  new detail. A wrong reason is worse than none: it sends the operator to fix
  a timeout that did not happen.
- **F2** — two probe timeouts duplicated per call site; the classifier's type
  does not bind them to the spawn option, so they can drift apart silently.
- **F3** — the `timeout:*` production path has no end-to-end coverage.
- **F5** — `every_failed_run_terminates_with_declared_completion_reasons`
  iterates a hand-maintained list; a new reason added without touching the list
  is untested (drift = silent regression, the registry lesson again).
- **F6** — `SpecError::InvalidTrigger` collapses two distinct faults into one
  message.
- **F8b** — `validateKernelRetry` names an authoring rule as if the kernel
  imposed it — a doc claim the kernel does not make.
- **F9** — `probeTrigger` catches every error with no classification, so a
  broken probe environment is indistinguishable from a bad trigger.
- **F10** — small load-bearing boundary details a reader will trip over.

Rule this produced: **a merge must not shrink the open-findings ledger.** What
a review leaves open moves here before the PR closes, or it is lost.

## Cloud sandbox verify gaps (2026-08-28, captured from run 404a8386)

The first cloud tick reached `verify` — sync ✅, assess ✅ (claude), build ✅
(codex) — and failed there on two environment facts, both ours to fix:

```
Step "verify" failed: /usr/bin/zsh: line 6: ../ops/cargo.sh: Permission denied

> @relayflows/sdk@0.1.0 test
> tsc --noEmit && vitest run
error TS2688: Cannot find type definition file for 'node'.
```

- **The executable bit does not survive the snapshot upload.** `ops/cargo.sh`
  arrives non-executable. Invoke it as `sh ops/cargo.sh` (or restore the mode
  in-step) rather than depending on file mode — the same "reproducible by
  construction, not by ambient file mode" rule a reviewer already made us
  learn once on a clean checkout.
- **`sdk/node_modules` is absent.** The snapshot carries `git ls-files`, so
  dependencies are not there. `verify` must install (`npm ci`) when
  `node_modules` is missing, and fail closed with a typed reason if install
  itself fails.

Both must hold on a laptop AND in a sandbox; a fix that only works in one is
the defect it replaces.
