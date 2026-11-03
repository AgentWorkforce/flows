# Hosted auto stage grants

Cloud PR #5944 limits repository write grants to auto stages E/F. The existing
land flow instead proves push access at every auto stage, so a correctly
read-only A stage refuses before review. Limit that preflight to E/F; early
review, fix and rebase stages keep read-only access. The preflight still refuses
an E-stage write denial before dispatching the GitHub gate or pushing.

Commands use Node v22.22.2 from this worktree. For the regression, temporarily
replace only the E/F condition with the old unconditional auto condition:

```sh
PATH=/Users/khaliqgant/.nvm/versions/node/v22.22.2/bin:$PATH node --experimental-strip-types --test --test-name-pattern='hosted auto allows read-only' examples/land/tests/flow.test.ts
```

The final regression test fails at read-only A-adversarial, exit 1: literal
[baseline.txt](baseline.txt). Restored `land.flow.ts` byte-for-byte, SHA256
`12e10654f13d52343a2d25d343de85642955825415c5a3cae20cee44bd018ffb`.
Then ran:

```sh
PATH=/Users/khaliqgant/.nvm/versions/node/v22.22.2/bin:$PATH npm --prefix examples/land run typecheck
PATH=/Users/khaliqgant/.nvm/versions/node/v22.22.2/bin:$PATH npm --prefix examples/land test
```

Both exit 0: literal [typecheck.txt](typecheck.txt) and
[land-tests.txt](land-tests.txt), 91 passed, 0 failed. The regression drives
A, B, a C fix round, and D without a push probe, then proves an E write denial
refuses. Existing matching-mode auto coverage still completes through F.
These are local fixtures; this does not prove the hosted grant boundary.

No runtime packages, model pins, or gates change. No npm release is needed.
The land operator must redeploy the source after human review and merge.

Literal hash check after restoration:

```sh
shasum -a 256 examples/land/land.flow.ts
```

```text
12e10654f13d52343a2d25d343de85642955825415c5a3cae20cee44bd018ffb  examples/land/land.flow.ts
```
