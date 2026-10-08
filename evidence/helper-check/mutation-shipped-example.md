# Mutation verification — the shipped-example regression test

## 1. Revert the fix (the authored `.flow.ts` opt-in in cli.ts)

```
$ sed -i 's/  const invocation = { warnUnresolvedHelperCredential: true };/  const invocation = {};/' packages/sdk/src/cli.ts
$ git diff packages/sdk/src/cli.ts
@@ -447,3 +447,3 @@ export async function runCli(
 async function checkAuthoredFlowComposed(path: string): Promise<{ report: CheckReport }> {
-  const invocation = { warnUnresolvedHelperCredential: true };
+  const invocation = {};
   const helper = await checkHelperBody(path, invocation);
$ sha256sum packages/sdk/src/cli.ts
d5b85a21a85115a0561011ed4dbda1b5f86a28d915c33c3466a07dfd45926f5d  packages/sdk/src/cli.ts
```

## 2. The test fails, with exactly the refusal from the report

```
$ cd packages/sdk && ./node_modules/.bin/vitest run tests/check-helper-surface.test.ts -t "answers the shipped Cloud-bound stale-issues example instead of refusing it"

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ❯ tests/check-helper-surface.test.ts (16 tests | 1 failed | 15 skipped) 99ms
   × answers the shipped Cloud-bound stale-issues example instead of refusing it 98ms
     → expected [ Array(1) ] to deeply equal []

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/check-helper-surface.test.ts > answers the shipped Cloud-bound stale-issues example instead of refusing it
AssertionError: expected [ Array(1) ] to deeply equal []

- Expected
+ Received

- Array []
+ Array [
+   "REFUSED [helper_slack.credential_missing] f.slack requires a relayfile slack mount; direct-token transport is not implemented.",
+ ]

 ❯ tests/check-helper-surface.test.ts:85:68
     83|   // workspace integration at submit, so inspection has to answer, not…
     84|   const result = await check(shippedExample('stale-issues'));
     85|   expect(result.stderr.filter(line => line.startsWith('REFUSED'))).toE…
       |                                                                    ^
     86|   expect(result.exit).toBe(0);
     87|   expect(result.stdout).toContain('REQUIRES slack (tools.slack), claud…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 15 skipped (16)
   Start at  14:15:50
   Duration  2.00s (transform 1.10s, setup 17ms, collect 1.70s, tests 99ms, environment 0ms, prepare 41ms)

```

## 3. Restore byte-for-byte

```
$ cp /tmp/cli.ts.orig packages/sdk/src/cli.ts
$ git diff --stat packages/sdk/src/cli.ts   # empty: identical to HEAD
$ sha256sum packages/sdk/src/cli.ts
83e60fd1e04acdc5ea679585c23923fd93fafd335c72077df776e0da9585d33c  packages/sdk/src/cli.ts
```

## 4. The test passes again

```
$ cd packages/sdk && ./node_modules/.bin/vitest run tests/check-helper-surface.test.ts -t "answers the shipped Cloud-bound stale-issues example instead of refusing it"

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ✓ tests/check-helper-surface.test.ts (16 tests | 15 skipped) 573ms
   ✓ answers the shipped Cloud-bound stale-issues example instead of refusing it 572ms

 Test Files  1 passed (1)
      Tests  1 passed | 15 skipped (16)
   Start at  14:15:52
   Duration  3.11s (transform 1.55s, setup 13ms, collect 2.35s, tests 573ms, environment 0ms, prepare 39ms)

```
