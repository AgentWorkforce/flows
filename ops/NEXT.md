# NEXT — single highest-priority work package

Written by the Relayflow Lead on 2026-08-27 (assess tick on branch
`flow/drive-45db231-08271202`, HEAD = `45db231`, identical to `main`).

## Assessment snapshot (evidence)

- **Standing directives checked first** (`ops/DIRECTIVES.md`): directive 1
  — **stay lean, de-vendor kernel deps (2026-08-27)** — is **unsatisfied**.
  At assessment time (`45db231`) `kernel/vendor/` was committed (125M on
  disk), `kernel/.cargo/config.toml` replaced crates-io with
  `vendored-sources`, and the gitattributes rule was in place. **Base
  correction:** main then moved to `e715601`, which already deleted the
  vendor tree, `kernel/.cargo/config.toml`, and the gitattributes rule
  (bundled into the "ops: backlog" commit). What remains unsatisfied at
  this branch's base: the `!kernel/vendor/**` rule in `.gitignore`, no
  hermetic cargo wrapper (so cargo still fails from a clean checkout via
  the broken `~/.cargo/registry` symlink), workflows/README still invoking
  bare cargo, and directive 1 still listed. Per the directives header, an
  unsatisfied directive outranks the backlog, so it **is** this tick's
  work package. WP-2 (llm step, rung (b)) waits.
- **Open PRs: none** (`gh pr list --state open` → `[]`). PR #2 merged as
  `74a3639`; nothing is awaiting review fixes.
- **Current gate: gate 1** (RFC-0001 §3). Its done-when does not hold yet:
  rung (a) is closed on `main` (crash-resume sweep merged in #2); rungs
  (b) (llm step + missing protocol verbs) and (c) (agent step + Appendix A
  pins) do not exist. Gate 1 remains the target after this directive tick.
- **Tests at assessment time (2026-08-27, this machine, vendored deps):**
  - `kernel/`: `cargo test --workspace` → exit 0 (doc-tests tail clean).
  - `sdk/`: `npm test` → **50 passed, 0 failed** (5 files).
- **Environment fact driving the directive:** `~/.cargo/registry` is a
  symlink to `/Volumes/Paris Drive/...cargo-registry` (unmounted → broken).
  Vendoring was the stopgap that made cargo work despite it; the directive
  replaces that stopgap with a lean hermetic approach.

## Work package: WP-DIR-1 — de-vendor kernel deps (standing directive 1)

### Objective

Make `cargo test/clippy/fmt` green **from a clean checkout with no
`kernel/vendor` dir and no manually exported env vars**, via a hermetic,
repo-scoped cargo home that does not commit the dependency graph; then
delete `kernel/vendor` and all its plumbing, and remove directive 1 from
`ops/DIRECTIVES.md` in the same PR (it is demonstrably satisfied by the
PR's own passing evidence).

Recommended approach (directive-compliant, works on any runner regardless
of the machine's broken `~/.cargo/registry` symlink): a tiny committed
wrapper — e.g. `ops/cargo.sh` — that execs
`env CARGO_HOME="<repo-root>/.cargo-home" cargo "$@"` (`.cargo-home/` is
already gitignored), used by humans and by the workflow test gates alike.
`CARGO_HOME` cannot be set from `.cargo/config.toml` (cargo reads it
before config), so a wrapper or per-step env line is required. First run
from a clean checkout downloads crates over the network into
`.cargo-home/`; `kernel/Cargo.lock` stays committed, so the build is still
pinned. Fixing the machine symlink itself (mount "Paris Drive" or replace
the symlink with a real directory) remains allowed by the directive but is
a machine-state change — do not depend on it for the definition of done.

### Files in scope

- `kernel/vendor/`, `kernel/.cargo/config.toml`, and the gitattributes
  rule — **already deleted on main in `e715601`** (see base correction
  above); no action in this diff.
- `.gitignore` — remove the `!kernel/vendor/**` rule and its comment;
  keep `.cargo-home/`.
- `ops/cargo.sh` (new) — hermetic cargo wrapper described above,
  executable, shellcheck-clean.
- `workflows/drive.yaml` (verify step, ~line 85) and
  `workflows/bootstrap-gate1.yaml` (kernel-tests step, ~line 98) — invoke
  cargo through the wrapper so the workflows' own gates run green on this
  machine without the vendor dir.
- `kernel/README.md` — document the wrapper and why it exists (broken
  `~/.cargo/registry` symlink; hermetic repo-scoped `CARGO_HOME`).
- `ops/DIRECTIVES.md` — remove directive 1 (satisfied by this PR).

### Definition of done

All of the following pass **from a clean checkout, with no vendor dir and
no manually exported environment variables** (the wrapper supplies
`CARGO_HOME`); paste the output in the PR body:

```sh
# clean-checkout proof (from the repo root of the flow branch)
tmp="$(mktemp -d)" && git clone --no-local . "$tmp/flows"
test ! -d "$tmp/flows/kernel/vendor"                      # vendor is gone
cd "$tmp/flows"
(cd kernel && ../ops/cargo.sh test --workspace)           # all green
(cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings)
(cd kernel && ../ops/cargo.sh fmt --check)
(cd sdk && npm test)                                      # 50/50 green
```

And these plumbing checks hold on the branch:

```sh
git ls-files kernel/vendor | wc -l          # 0
git ls-files kernel/.gitattributes | wc -l  # 0
! grep -q 'vendored-sources' -r kernel/.cargo 2>/dev/null
! grep -q 'kernel/vendor' .gitignore
```

Test counts must not shrink: the kernel suite that passed at assessment
(incl. the crash-resume sweep from PR #2) and the sdk 50/50 all still pass.

### Out of scope for this tick

- **Purging the vendored blobs from git history.** `git rm` shrinks the
  checkout, not `.git` history; a history rewrite (filter-repo +
  force-push) is a human decision — note it in the PR body, do not do it.
- **Touching `~/.cargo`** (replacing the broken symlink, mounting "Paris
  Drive") — machine state, not repo state.
- **WP-2 / gate-1 rung (b)** — the `llm` step and missing protocol verbs
  (`worker.attach`, `step.heartbeat`, `step.complete`, `run.watch`,
  `stream.*`, `event.emit`). This is next after the directive is satisfied.
- **Rung (c)**, durable channels, `flows check` preflight, gates 2–9.
- Any RFC or charter edits; any sdk source changes.

### Delivery

One PR against `main` from a `flow/` branch. The Lead does not merge;
report the clean-checkout evidence verbatim in the PR body and await
human review (per charter hard rails).

ASSESS_DONE
