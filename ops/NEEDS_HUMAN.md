# Gate 3 needs human resolution

The gate 3 work package's requested `@types/node` dependency is already present
in both `sdk/package.json` and `sdk/package-lock.json`. `npm install` completes,
and TypeScript compilation succeeds.

The definition-of-done command `cd sdk && npm test` nevertheless fails
reproducibly in the live kernel test
`hn-monitor analyze-story reaches done through the real Claude analyzer CLI`.
The completed journal entry has `payload.verification === null`, while the test
requires `{ gate: "json_schema", verdict: "pass" }`. Two consecutive full runs
produced the same single failure (661 passed, 1 failed, 3 skipped).

Resolving this requires changing SDK/kernel implementation or a judging test.
Both are outside this package: `ops/NEXT.md` permits only the missing dependency
fix in `sdk/package.json`, and `ops/TARGET.md` assigns SDK implementation to Track
A and forbids editing a gate that judges this work. The definition of done cannot
be made green within the authorized scope.

Additionally, the workspace `.git` file points to the absent path
`/home/daytona/.project-git`, so the mandated final `git status --porcelain`
cannot inspect repository state in this run.
