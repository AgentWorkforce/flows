# Review 8 repair evidence for #667

This bundle tests the review-8 repairs on the SDK source above `3e008e9e`.
The kernel source is unchanged. The final SDK build's three changed runtime
modules match the Linux arm64 staged copy byte-for-byte
(`sdk-dist-hashes.log`). All live runs used native arm64 `node:22-trixie`, one
container, and a named Docker volume; no Paris Drive path was bind-mounted.
`h8.mjs`, `s8.mjs`, and `probe8.mjs` are the reviewer's exact code fences from
`~/relay-briefs/ms-flows-parallel-667-review8-fixtures.md`. The prior `h7.mjs`,
`s7.mjs`, `s.mjs`, `s2.mjs`, `s3.mjs`, `s4.mjs`, and `timing7.mjs` are from the
previous evidence bundle. `COMMANDS.md` gives the commands and log names.
`raw-logs.tar.gz` retains the captured log bytes; the browsable `.log` files
have trailing whitespace and extra blank lines trimmed for `git diff --check`.

## Repairs and live outcomes

| Finding | Repair | Exact reviewer fixture result |
| --- | --- | --- |
| F1: false preload flags and terminal resume failure | Parse whole Node option tokens; check a pinned parallel root before `run.resume` and again after source import. Unsafe environment refusal leaves the root resumable. | RS1/RS2 and their clean second-resume forms complete 6/6 each in parallel mode. RS3's preload resume refuses 6/6 with effects `bcaX`; RS3bh's clean second resume completes `bcaXZ` 6/6. |
| F2: fulfilled join with pending members | Record the tracked members of each `all`/`allSettled` and refuse a follow-up when a settled join still has a pending member. Snapshot the Array iterator and its `next`; compare a certified array's indexed members with the iterable view. | PL8hide fails before X in 6/6, effects `b`, no replay. PL9dep, PL8r and PL8iter use safe serial fallback in 6/6 each; no replay. |
| F3: slow failure report | Document that admitted children finish and are journaled before root failure. | Deep-forced F5w still takes about 15 s and admits neither Q nor L; the reviewer `<10 s` predicate correctly reports 0/6, with no replay. |

The final-build `s7.mjs` matrix ran 27 scenarios × six kill offsets: 162/162
without replay (`final-s7.log`). Twenty-four scenarios met the reviewer
predicate in all six runs. PL3sub, PL4ctor, and SEC7 retain the published-base
equivalent predicate mismatches described in the prior evidence bundle.

The final-build `s8.mjs` matrix ran 324 crash/resume cases: 120 head, 162
2.0.51-base, and 42 deep-forced. All 324 had zero replay (`final-s8.log`).
The deliberate refusal cases and base-equivalent failures explain the
reviewer's 276/324 `ok` flags. DP1, OPT1, TV1, EP1, SEC8m, and PL9depnone
completed 6/6 in parallel mode. The exact certifier probe matches the
reviewer's expected table (`probe8.log`).

## Revert proofs

`mutation-stage.py` makes four scratch SDK `dist` copies from this build; it
does not modify the worktree or the staged candidate:

| Scratch side | Removed guard | Observed result |
| --- | --- | --- |
| `fx` | Whole-token parser, restoring the old regex | Harmless RS1 flag refused 6/6 (`mut-f1-parser.log`). |
| `m1` | Pre-dispatch parallel resume check | RS3 preload terminalized the root; clean second resume failed 6/6 (`mut-f1-resume.log`). |
| `m3` | Array iterator admission check only | The pending-member backstop still refused PL9dep before X, effects `b`, 6/6 (`mut-f2-backstop.log`). |
| `m2` | Array iterator admission check and settlement backstop | PL9dep admitted X before its pending branches in 12/12 and replayed in 1/12; PL8hide replayed in 4/12 (`mut-f2-removed.log`, `mut-f2-hide.log`). |

## Regression and overlap checks

The exact review-7 timing driver alternated ten warm head/base pairs of three
300 ms routes, each followed by a 100 ms dependent. At this head, body p50 was
461 ms versus 1,383 ms on the 2.0.51 base build; CLI p50 was 1,088 versus
1,847 ms, and route start spread p50 was 6 versus 661 ms. Routes and
dependents overlapped in 10/10 head runs and 0/10 base runs
(`final-timing.log`).

`npm run build`, SDK typecheck, test typecheck, eight focused Vitest files
(133 tests), and both local-daemon secret live tests passed. Their complete
logs are `sdk-build.log`, `sdk-typecheck.log`, `sdk-typecheck-tests.log`,
`sdk-focused-unit.log`, and `sdk-secrets-live.log`.
