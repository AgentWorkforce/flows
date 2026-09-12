# Verification

Captured locally on 2026-09-10. Deterministic verification only; no model trials were rerun.

The gate-file rewrite regression first failed against the old runtime. This is a fail-before/pass-after regression, not mutation verification. The earlier failure output below is rendered with trailing whitespace removed using `sed 's/[[:space:]]*$//' /tmp/flows291-audit/gate-integrity-before.txt`; the test text is otherwise unchanged.

```text
$ node --experimental-strip-types --test examples/skill-vs-flow-compliance/shims/gate-integrity.test.ts
✖ rewriting gate files after startup cannot change the executed checks (360.969042ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 466.501833

✖ failing tests:

test at examples/skill-vs-flow-compliance/shims/gate-integrity.test.ts:10:1
✖ rewriting gate files after startup cannot change the executed checks (360.969042ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  true !== false

      at TestContext.<anonymous> (file:///Users/khaliqgant/lanes/flows291/repo/examples/skill-vs-flow-compliance/shims/gate-integrity.test.ts:33:12)
      at async Test.run (node:internal/test_runner/test:1208:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:385:3) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: true,
    expected: false,
    operator: 'strictEqual',
    diff: 'simple'
  }
```

```text
$ node --experimental-strip-types --test examples/skill-vs-flow-compliance/shims/runtime.test.ts examples/skill-vs-flow-compliance/shims/gate-integrity.test.ts
✔ rewriting gate files after startup cannot change the executed checks (353.072083ms)
✔ existing evidence and repository are refused without changing bytes (195.2155ms)
✔ host tool settings stay local without blocking a committed task (600.559875ms)
✔ empty and deletion-only scans pass; an invalid baseline fails (385.592375ms)
✔ compliant final tree passes all checks; violating commit fails all four (800.591ms)
✔ uncommitted repair cannot hide failing committed test; all work is captured (466.587666ms)
✔ sanitization retains Skill calls and task results, removes host metadata (0.619042ms)
✔ flow control: first-pass (0.188042ms)
✔ flow control: repair (0.092291ms)
✔ flow control: still-failing (0.121083ms)
✔ real checks drive one repair turn before success (844.710375ms)
ℹ tests 11
ℹ suites 0
ℹ pass 11
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3406.815208
exit=0
```

```text
$ node --experimental-strip-types examples/skill-vs-flow-compliance/shims/audit-evidence.ts
agent-no-skill/trial-1: final checks match; Skill calls=0; all pass
agent-no-skill/trial-2: final checks match; Skill calls=0; all pass
agent-no-skill/trial-3: final checks match; Skill calls=0; all pass
agent-no-skill-hard/trial-1: final checks match; Skill calls=0; check-tests-pass,check-commit-message
agent-no-skill-hard/trial-2: final checks match; Skill calls=0; check-tests-pass
agent-no-skill-hard/trial-3: final checks match; Skill calls=0; check-tests-pass
agent-plus-skill/trial-1: final checks match; Skill calls=1; all pass
agent-plus-skill/trial-2: final checks match; Skill calls=1; all pass
agent-plus-skill/trial-3: final checks match; Skill calls=1; all pass
agent-plus-skill-hard/trial-1: final checks match; Skill calls=0; check-tests-pass
agent-plus-skill-hard/trial-2: final checks match; Skill calls=0; check-tests-pass,check-commit-message
agent-plus-skill-hard/trial-3: final checks match; Skill calls=0; check-tests-pass
agent-plus-skill-hard-nudged/trial-1: final checks match; Skill calls=1; all pass
agent-plus-skill-hard-nudged/trial-2: final checks match; Skill calls=1; all pass
agent-plus-skill-hard-nudged/trial-3: final checks match; Skill calls=1; all pass
relayflow/run-1: final checks match; Skill calls=0; all pass
relayflow/run-2: final checks match; Skill calls=0; all pass
relayflow/run-3: final checks match; Skill calls=0; all pass
relayflow-hard/run-1: final checks match; Skill calls=0; all pass
relayflow-hard/run-2: final checks match; Skill calls=0; all pass
relayflow-hard/run-3: final checks match; Skill calls=0; all pass
Audited 21 captured final trees. Intermediate attempts and test-first ordering were not reconstructed.
exit=0
```

```text
$ npm --prefix examples/skill-vs-flow-compliance run typecheck

> typecheck
> ../../packages/sdk/node_modules/.bin/tsc -p tsconfig.json

exit=0
```
