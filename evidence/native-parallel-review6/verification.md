# #667 review 5 repair verification

Candidate source is based on `78e7d1fcc0bf58ade55b13c68c347c312b7f85f5` (2.0.51). The rebuilt SDK's `dist/authored-flow-lifecycle.js` SHA-256 is `933e84fab3c8bc86a40b4799f2b33edee58c75a252a40eb5d4a7d8f6e33e65d2`; eligibility, promise graph and step graph digests are respectively `575d20380baf2f258bd8efa4cb05da2769c7e0c8c9727329f2acd94dcc3921ae`, `4a8bb1a1142fe2650c82b46e77a3d8ea5d6a8ab4b3cb32a527ed1b15228b9d55`, and `c039cfc347cb1a5134b0eae206f9869d7bed7f8c1c950f83a82290ed55e1c436`. The final Linux x64 image is `ms-flows-parallel:review6-final` (`sha256:fd469694f2e49c733bea8375891b88b6bc15b2c6e7dd3c5726784cdfcb35417e`).

## Reviewer fixtures

The copied [reviewer fixture brief](review5-fixtures.md) has SHA-256 `6a38c9c39bf448032b114d973201dd42a9d33fc1cbcea6bfd728e7f538f76688`, identical to `~/relay-briefs/ms-flows-parallel-667-review5-fixtures.md`. [review5-exact.mjs](review5-exact.mjs) reads its seven flow and patch source blocks directly. It uses the reviewer's six kill delays `[0, 60, 130, 220, 330, 450]` ms, two process sweeps, root detection from `run.spawned`, and both effect-file and child-journal replay checks. The shell-only fixture's unused adapter is a stub; all flow and patch source blocks are copied verbatim. Journal SQL is run through Python's `sqlite3` module instead of the `sqlite3` CLI. The daemon is the published 2.0.51 Linux x64 binary rather than the reviewer's locally built dev-profile binary.

```sh
docker run --rm --platform linux/amd64 --init \
  -v "$PWD/evidence/native-parallel-review6/review5-exact.mjs:/bench/review5-exact.mjs:ro" \
  -v "$PWD/evidence/native-parallel-review6/review5-fixtures.md:/bench/review5-fixtures.md:ro" \
  ms-flows-parallel:review6-final node /bench/review5-exact.mjs
```

[Final fixture output](linux-review5-exact.log): Q5, Q5n, Q5h, Q5w, Q5wn and Q5wh each resumed 6/6 in serial mode with no duplicate effect or command admitted under a second step ID. Q6Pw failed closed before X in parallel mode 6/6. The Q5 cases remain runnable on fresh starts; the earlier first-turn failure did not recur.

## Runtime guard mutation

With only the source eligibility gate forced open, the exact Q5w source fails before X on all six fresh runs ([guard output](linux-forced-guard.log)). With the same forced eligibility and only `hasUnobservedJoinShape()` disabled in the compiled SDK, X was appended twice in 3/6 crash-and-resume runs ([mutation output](linux-forced-no-guard.log)). Both runs used the final image. This mutation changes neither the fixture nor the observer identity check.

```sh
docker run --rm --platform linux/amd64 --init -e CASE=Q5w -e REVIEW5_MUTATION=forced_guard \
  -v "$PWD/evidence/native-parallel-review6/review5-exact.mjs:/bench/review5-exact.mjs:ro" \
  -v "$PWD/evidence/native-parallel-review6/review5-fixtures.md:/bench/review5-fixtures.md:ro" \
  ms-flows-parallel:review6-final node /bench/review5-exact.mjs
docker run --rm --platform linux/amd64 --init -e CASE=Q5w -e REVIEW5_MUTATION=forced_no_guard \
  -v "$PWD/evidence/native-parallel-review6/review5-exact.mjs:/bench/review5-exact.mjs:ro" \
  -v "$PWD/evidence/native-parallel-review6/review5-fixtures.md:/bench/review5-fixtures.md:ro" \
  ms-flows-parallel:review6-final node /bench/review5-exact.mjs
```

## Compatibility and overlap

- [Prior replay matrix](linux-prior-replay.log): A1, B1, N2, C1e, G1, ANY, I1, H1, K4, H2 each resumed 6/6 without duplicate effects on the candidate before the final narrowing of the observer identity check.
- [2.0.51 → candidate](linux-upgrade-2051.log) and [2.0.50 → candidate](linux-upgrade-2050.log): A1, B1, N2 each resumed 6/6 with no duplicate effects. The only source change after these runs narrowed the observer check from all four intrinsic combinators to `all` and `allSettled`.
- [Candidate → 2.0.51 → candidate](linux-rollback-2051.log) and [candidate → 2.0.50 → candidate](linux-rollback-2050.log): old CLI refused a parallel v2 root 6/6 with `malformed authority metadata`, effects stayed `abc`, then candidate resumed to `Zabc` 6/6. These runs preceded the same observer-check narrowing.
- [Paired Native overlap](linux-native-overlap.log): ten alternating 2.0.51 base and candidate runs, three 300 ms routes each with a 100 ms dependent. Base route and dependent overlap were 0/10; candidate both 10/10. Body p50 was 1611 ms base and 562 ms candidate; route start spread p50 was 746 ms base and 6 ms candidate. The host was shared, so absolute CLI latency is less stable than the overlap and body-time result. This run preceded the same observer-check narrowing.

Local SDK checks after the final source edit:

```sh
cd packages/sdk
npm run typecheck:tests
npm run typecheck
npx vitest run tests/authored-flow-lifecycle-executor.test.ts tests/authored-parallel-eligibility.test.ts tests/authored-step-graph.test.ts --reporter=dot
```

All 75 focused tests passed, including forced late joins, observer replacement, direct branch dependents and immediate closure of a queued ninth child. The broader authored parallel live suite passed 33 tests (7 published-CLI-dependent tests skipped) before the observer-check narrowing. Its new reviewer Q6Pw and re-export cases also passed in a targeted Mac rerun.

The [final Mac live run](mac-final-live.log) passed 100 of 101 tests. All new Q5/Q6, secret, Native overlap, legacy-upgrade, rollback, and prior replay cases passed. One six-repeat imported-timer helper test got `status: null` from the fixture's 30-second synchronous CLI timeout during resume. It [passed all six repetitions when rerun alone](mac-imported-timer-isolated.log), taking 175 seconds total. The full-run timeout remains a test reliability concern; the Linux prior replay matrix passed this shape 6/6 and the final exact reviewer matrix passed 42/42.
