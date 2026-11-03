# Hosted land mode agreement

Cloud passes its persisted run mode as `mergeMode`. Before this change,
`parseInput` discarded it, and the flow used `mergePolicy.mode` independently.
An auto request with a shadow config could complete without pushing while Cloud
interpreted the result as an auto landing.

The flow now retains and validates the optional request mode and requires it to
match the initial pinned config or persisted config before work, including
terminal and already-advanced replays. It refuses mismatches without rewriting
state. Local inputs may omit the mode. No runtime packages or model gates change.

Commands run from this worktree with Node v22.22.2:

```sh
PATH=/Users/khaliqgant/.nvm/versions/node/v22.22.2/bin:$PATH node --experimental-strip-types --test --test-name-pattern='hosted (crossed|matching|mode mismatch)' examples/land/tests/flow.test.ts
```

Before the implementation, with the four regression tests added: exit 1,
3 failures and 1 pass. Literal captured output: [baseline.txt](baseline.txt).

```sh
PATH=/Users/khaliqgant/.nvm/versions/node/v22.22.2/bin:$PATH npm --prefix examples/land run typecheck
PATH=/Users/khaliqgant/.nvm/versions/node/v22.22.2/bin:$PATH npm --prefix examples/land test
```

After implementation and input validation coverage: both exit 0. Literal
captured output: [typecheck.txt](typecheck.txt), [land-tests.txt](land-tests.txt)
(90 passed, 0 failed). These are local fixture tests, not a hosted smoke.
Deployment is owned by the land operator after review and merge.
