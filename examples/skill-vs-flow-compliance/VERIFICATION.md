# Verification

Captured locally on 2026-09-10. Deterministic verification only; no model trials were rerun.

```text
$ node --experimental-strip-types --test examples/skill-vs-flow-compliance/shims/runtime.test.ts
✔ existing evidence and repository are refused without changing bytes (178.375958ms)
✔ host tool settings stay local without blocking a committed task (530.18175ms)
✔ empty and deletion-only scans pass; an invalid baseline fails (356.12325ms)
✔ compliant final tree passes all checks; violating commit fails all four (797.042875ms)
✔ uncommitted repair cannot hide failing committed test; all work is captured (472.048708ms)
✔ sanitization retains Skill calls and task results, removes host metadata (0.583667ms)
✔ flow control: first-pass (0.1715ms)
✔ flow control: repair (0.094125ms)
✔ flow control: still-failing (0.11925ms)
ℹ tests 9
ℹ suites 0
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2452.153625
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
