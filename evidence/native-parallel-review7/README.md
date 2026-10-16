# Review 6 replay evidence for #667

The candidate is based on flows 2.0.51. The arm64 runs used `node:22-trixie` and
`relayflowd` built from this branch's kernel. Published SDKs 2.0.50 and 2.0.51
came from npm; the 2.0.50 daemon was built from `da6eeb3f`. The harness,
dependencies, fixtures, and journals lived in a named Docker volume. Each
matrix ran in one container at a time, with six kill offsets (0–450 ms).

`s.mjs` and `s2.mjs` preserve the reviewer's scenario generators. The review
did not preserve an R5n generator block, so `review6-exact.mjs` reconstructs
its entry from the reported source and uses the reported patch module exactly.
The harness checks effect uniqueness, completed run identities, execution mode,
and refusal before new effects for rollback. It scopes identical commands in
separate dispatched child flows by dispatch id.
`COMMANDS.md` records each literal Docker command; the log files below are the
complete captured stdout and stderr for those commands.
The original log bytes are also in `raw-logs.tar.gz`; the browsable `.log`
files differ only by normalized trailing blank lines so `git diff --check`
passes.

| Matrix | Result | Log |
| --- | ---: | --- |
| R1/R1w/R1wn/R2w/R3/R3w/R4w/R1c/R5n | 54/54 clean, serial | `arm-volume-r-all.log` |
| Q5/Q5n/Q5h/Q5w/Q5wn/Q5wh/Q6Pw | 42/42 clean, serial | `arm-volume-q.log` |
| E1–E5 entry variants | 36/36 clean, serial | `arm-volume-e.log` |
| Prior P/C/G/H/K/I variants | 96/96 clean, serial | `arm-volume-prior-all.log` |
| A1/B1/N2 | 18/18 clean, parallel | `arm-volume-native.log` |
| 2.0.50 → candidate, CI4/CI5/A1/B1/N2 | 30/30 clean | `arm-volume-upgrade2050.log` |
| 2.0.51 → candidate, same shapes | 30/30 clean | `arm-volume-upgrade2051.log` |
| Candidate → 2.0.50, same shapes | 30/30 safe rollback | `arm-volume-rollback2050.log` |
| Candidate → 2.0.51, same shapes | 30/30 safe rollback | `arm-volume-rollback2051.log` |
| Forced eligibility, all 14 FR variants | 84/84 failed closed, zero effects | `arm-volume-forced.log` |

K1 is a known base failure: candidate and published 2.0.51 both report
`run_admission_conflict` in 6/6 sweeps with effects `ABLC` and no duplicates
(`arm-volume-k1-head.log`, `arm-volume-k1-base2051.log`). Q6Pw, which failed
on fresh runs in review 6, now uses serial mode and completes 6/6.

The forced run applied the reviewer's `parallelRunEligible` return-true mutation
to the built SDK. The separate execution-time body certificate rejected every
unsupported shape before admitting an effect. The pristine built file was
restored and byte-compared afterward.
The final local build matches the staged Docker build for the eligibility,
body, lifecycle, and step-graph modules byte-for-byte (`sdk-dist-hashes.log`).

## Native timing

`timing.mjs` runs three 300 ms routes, each with a 100 ms dependent, then a
join. It alternates published 2.0.51 and candidate runs in ten warm pairs,
after one warm-up of each. Journal `at_ms` values measure body and route spans;
wall time measures the CLI. See `arm-volume-timing.log` for all samples.

| Metric | Published 2.0.51 | Candidate |
| --- | ---: | ---: |
| Body p50 / p95 | 1,379 / 1,400 ms | 463 / 499 ms |
| CLI p50 / p95 | 1,848 / 1,900 ms | 1,125 / 1,153 ms |
| Route start spread p50 | 662 ms | 5 ms |
| Route overlap | 0/10 | 10/10 |
| Dependent overlap | 0/10 | 10/10 |

## Focused checks

- `npm run build`, `npm run typecheck`, and `npm run typecheck:tests` passed
  (`sdk-build.log`, `sdk-typecheck.log`, `sdk-typecheck-tests.log`).
- Seven focused Vitest files passed, 87 tests total, including the structural
  frontier, source identity, and Promise-intrinsic assertions
  (`sdk-focused-unit.log`).
- `authored-step-secrets-live.test.ts` passed both local-daemon tests, including
  different grants in parallel shell children (`sdk-secrets-live.log`).
- A real `npm ci` completed in the SDK worktree. `node_modules` and its Surface
  package are directories, and Surface resolves inside this worktree
  (`sdk-npm-ci.log`, `workspace-resolution.log`).

Four temporary source mutations were tested with the literal command
`bash evidence/native-parallel-review7/mutation-proof.sh > evidence/native-parallel-review7/mutation-proof.log 2>&1`.
The script captures each failing assertion, restores the source byte-for-byte
(`cmp` and SHA-256), and captures a passing rerun. `mutation-proof.log` has the
commands, hashes, and complete output.

| Removed guard | Selected test result | Log |
| --- | --- | --- |
| User-built join refusal in `AuthoredStepGraph` | 1 failure: user-built join was trusted | `mut-f1-fail.log`, `mut-f1-pass.log` |
| Direct Surface import requirement | 1 failure: entry identity | `mut-f2-binding-fail.log`, `mut-f2-binding-pass.log` |
| Exact exported body comparison | 1 failure: entry identity | `mut-f2-body-fail.log`, `mut-f2-body-pass.log` |
| `Promise.resolve` identity check | 1 failure: replacement went undetected | `mut-f3-fail.log`, `mut-f3-pass.log` |

The entry identity test uses the actual body with a missing or local Surface
binding, as well as a decoy body with a direct import. The step-graph test
distinguishes a user-built join from a certified branch call. The intrinsic
test replaces every Promise method plus the constructor. The forced FR matrix
checks the execution-time certificate independently of entry eligibility.

An earlier attempt bind-mounted fixtures from the USB Paris Drive and Docker
Desktop became unresponsive after 31 clean R sweeps. The complete matrices
above use a named volume and did not repeat that host failure.
