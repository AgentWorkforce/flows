# Review 7 repair evidence for #667

This bundle tests the six review-7 fixes on the SDK working tree above
`e3503c08`. The production source changes are SDK-only. The Linux arm64
`relayflowd` in the named Docker volume is the prior branch build; the kernel
source is unchanged. The rebuilt candidate SDK `dist` in that volume matches
the final local build byte-for-byte for the four changed runtime modules
(`sdk-dist-hashes.log`). Published 2.0.50 and 2.0.51 SDKs and Surface packages
were used for compatibility checks. `published-2051-pin.log` shows that the
2.0.51 side differs from the candidate and matches the published base copy.

All Docker runs used native arm64 `node:22-trixie`, one container at a time,
with fixtures and journals in the `ms-flows-parallel-r7` named volume. No Paris
Drive paths were bind-mounted. `COMMANDS.md` records the literal test commands
and names their complete captured stdout/stderr logs. `h7.mjs`, `s7.mjs`,
`probe.mjs`, and `timing7.mjs` are the reviewer's exact code fences from
`~/relay-briefs/ms-flows-parallel-667-review7-fixtures.md`. The prior `s.mjs`,
`s2.mjs`, `s3.mjs`, and `s4.mjs` are the review-6 generators, including its
recorded E1factory and rollback-expectation patch to `s2.mjs`.
`raw-logs.tar.gz` preserves the captured log bytes; the browsable `.log` files
have trailing whitespace and extra blank lines trimmed for `git diff --check`.

## Review-7 fixes

| Fix | Check and result |
| --- | --- |
| F1: parenthesized branch calls | The grammar and instrumenter share one unwrap helper. PAR1/PAR2 resumed 6/6 in parallel mode; `probe.mjs` reports two wrapped calls for each. |
| F2: certifier name capture | A body referencing `__certifyParallelBranch` uses serial mode. HY1/HY1s/HY2 completed 6/6 without duplicate effects. |
| F3: preloaded Promise patches | New roots use serial mode if native intrinsics or preload flags cannot be certified. PL1r5, PL2then, PL7mid, PL7neutral, PL6child, PL6late completed 6/6 in serial mode without replay. |
| F4: unknown combinator members | A member with no owned step or tracked promise id is refused before its `then` is read. Deep-forced FRthen failed before X in 6/6, with no replay. A proxy-thenable unit test proves its getter is not invoked. |
| F5: prompt root failure | The executor races the body against a violation signal. With only preload admission deliberately bypassed, PL7mid failed promptly in 6/6; removing the race hung until the shortened harness timeout, then byte-for-byte restoration restored prompt failure. |
| F6: species and constructor | The snapshot includes `Promise[Symbol.species]`, `Promise.prototype.constructor`, their descriptors, and `Function.prototype.toString`. Targeted tests catch each replacement. |

The exact `s7.mjs` head matrix ran 27 scenarios × 6 kill offsets = 162 runs
(`h7-s7-head.log`). It reported no replay. Twenty-four scenarios met their
fixture expectation in all six runs. The remaining three—PL3sub, PL4ctor,
SEC7—had the **same code and effects on published 2.0.51** in the six-run
base controls (`h7-base-fail-controls.log`). PL3sub and PL4ctor write `abcXZ`
but exit 1 on both sides. SEC7 omits `RELAY_SECRET_ENV_NAMES`; its ungranted
children see the ambient token on both sides, so the reviewer's scoping
expectation fails. SEC7m, with the manifest, passed 6/6 in parallel mode with
only the granted children receiving the token. SEC7miss refused before a child.

## Prior replay and compatibility gate

| Matrix | Result | Log |
| --- | --- | --- |
| R1/R1w/R1wn/R2w/R3/R3w/R4w/R1c, plus R5n | 54/54 clean, serial | `h7-prior-r.log`, `h7-prior-r5n.log` |
| Q5/Q5n/Q5h/Q5w/Q5wn/Q5wh/Q6Pw | 42/42 clean, serial | `h7-prior-q.log` |
| E1factory/E2helper/E3dyn/E4json/E4jsonuse/E5ns | 36/36 clean, serial | `h7-prior-e.log` |
| P/C/G/H/K/I prior shapes | 90/96 pass the reviewer's checker; I1's six flags are identical on base | `h7-prior-p.log`, `h7-i1-base-control.log` |
| A1/B1/N2 | 18/18 clean, parallel | `h7-prior-native.log` |
| Forced eligibility FR ×14 | 84/84 failed closed before any effect, zero replay | `h7-prior-fr.log` |
| Deep-forced FR ×14 | 84/84 no replay; FRthen now refuses | `h7-prior-deep.log` |
| Forced FB guards | FB1/2/3/3c/4/6/8 meet their 6/6 expectations | `h7-prior-fb.log` |
| Published 2.0.50/2.0.51 → candidate, five shapes | 60/60 clean | `h7-upgrade-pinned.log` |
| Candidate → published 2.0.50/2.0.51, five shapes | 60/60 safe; 36 parallel refusals, 24 accepted serial roots | `h7-rollback-pinned.log` |
| Prior S1/S2missing secret cases, head and base | 24/24 match | `h7-prior-secrets.log` |

I1's checker flags two identical dispatched child completion-marker commands
as a replay. Head and published base both finish `xyLRZ` 6/6 with no repeated
effect letter; the same false positive is documented by review 7. K1 is an
existing base failure: both head and base report `run_admission_conflict`
6/6, effects `ABLC`, no replay (`h7-k1-controls.log`). FB7 is an artificial
forced-eligibility case with a module-level Promise binding; it completes
`XZ` without replay, but the fixture expects refusal. Natural admission keeps
that source serial. For rollback, the reviewer's RBCI4/RBCI5 predicate expects
the old CLI to refuse, while these are serial v2 roots that the old CLIs
correctly accept; all 24 complete once with no replay.

## Native overlap and focused checks

The exact review-7 timing driver alternated ten warm head/base pairs. Three
300 ms routes each had a 100 ms dependent. Shell timestamps show body p50
460 ms at head versus 1,376 ms on published base; CLI p50 was 1,128 versus
1,860 ms. Route start spread p50 was 5 versus 660 ms. Routes and dependents
overlapped in 10/10 head runs and 0/10 base runs (`h7-timing.log`).

`npm run build`, `npm run typecheck`, `npm run typecheck:tests`, eight focused
Vitest files (130 tests), and both local-daemon secret live tests passed. The
source-faithful authored-root fixture retains its parallel expectation; a
separate synthetic-source fixture checks serial fallback. Logs are
`sdk-build.log`, `sdk-typecheck.log`, `sdk-typecheck-tests.log`,
`sdk-focused-unit.log`, and `sdk-secrets-live.log`. A real `npm ci` and
directory-based SDK dependencies were already recorded in the previous
[review-6 evidence](../native-parallel-review7/README.md).

`mutation-proof.py` temporarily removed F1, F2, F3, F4, and F6 guards. Each
selected assertion failed, the original source was restored byte-for-byte
with a matching SHA-256, and the assertion passed. `mutation-proof.log` plus
the `mut-*-fail.log`/`mut-*-pass.log` files capture each command and output.
`f5-mutation-proof.sh` used a scratch SDK and a shortened copy of the exact
harness (`h7-f5.mjs`, changing only the SDK path and stall deadline): 6/6
prompt failures before mutation, 1/1 timeout with the race removed, and 6/6
prompt failures after restoring the compiled module byte-for-byte. Its logs
and matching hashes are in `f5-*.log` and `h7-f5-*.log`.
