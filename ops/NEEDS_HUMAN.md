# Gate 3 needs human intervention

The scoped review-swarm implementation is already present and its YAML and
shell parsing checks pass, but this work package cannot meet its definition of
done in the supplied checkout:

1. `cd sdk && npm test` fails in the out-of-scope Track A test
   `tests/live-kernel.test.ts`. The hn-monitor analyzer completion has
   `payload.verification: null`; the test requires
   `{ gate: "json_schema", verdict: "pass" }`. The run completed with 661
   passing tests, one failing test, and three skipped tests. Gate 3 explicitly
   forbids changes under `sdk/`, so this run cannot repair that failure.
2. The checkout's `.git` file points to `/home/daytona/.project-git`, which
   does not exist. Consequently the required final `git status --porcelain`
   command fails with `fatal: not a git repository`.

Provide a checkout with valid Git metadata and a green Track A SDK baseline,
then rerun the gate 3 definition of done.
