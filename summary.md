`flows check` now collapses repeated `unprovable_effects` warnings into one line,
so a suspicious command remains visible. `--explain-warnings` restores every
original per-step diagnostic, including in watch mode. JSON stdout retains the
original report; only its accompanying stderr is summarised.

The change follows `reviewed-plan.md`: folding is an explicit renderer opt-in,
starts at two affected steps, counts distinct step IDs, and preserves other
kinds in order before appending the summary. The denominator includes every step.
The ladder examples consequently read `2 of 2`, `2 of 3`, and `2 of 3`.

Scope: fixes `check` on YAML/JSON specs. The external 58-step spec's format has
not been confirmed. Authored TypeScript checks do not currently produce these
step diagnostics. `run`/`resume`/`deploy` retain their current rendering, with a
follow-up recorded in `ops/BACKLOG.md`. Stdout still prints each `GATE` line.
No effect proving, spec-schema changes, kernel changes, or workflow edits.

Regression coverage includes opt-in isolation, single-step and duplicate-step
cases, missing step IDs, exact diagnostic ordering, full per-step explanation,
JSON serialization equality, invalid flags, and real watch-child forwarding.
The run-renderer regression uses a deliberate daemon-unreachable invocation
with `--no-spawn`; it verifies warning rendering, not live kernel execution.
The explicit per-step explanation assertion supplies coverage that the existing
ladder prefix assertions no longer provide after folding.

The `relay-cli-surface.test.ts` change only adds an INVOCATIONS sample for the
newly declared flag. Existing gate assertions remain intact; no covenant-2
assertion or preflight implementation was edited.

Verification commands and captured output follow. All final commands below
completed successfully. During implementation, the first build was mistakenly
launched at the repository root (no package.json); the first SDK build found an
import inserted ahead of the CLI shebang (TS18026/TS1005). The import was moved
below the shebang before the successful build and checks captured here.

```text
$ cd packages/sdk && npm run build

> @relayflows/sdk@2.0.42 build
> tsc && node scripts/make-cli-executable.mjs

```

```text
$ cd packages/sdk && npm run typecheck

> @relayflows/sdk@2.0.42 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json

```

```text
$ cd packages/sdk && npm run typecheck:tests

> @relayflows/sdk@2.0.42 typecheck:tests
> tsc -p tsconfig.tests.json

```

```text
$ cd packages/sdk && npx vitest run tests/check-warning-summary.test.ts

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ✓ tests/check-warning-summary.test.ts (12 tests) 1676ms
   ✓ flows check warning presentation > forwards explain=false to the watch child 822ms
   ✓ flows check warning presentation > forwards explain=true to the watch child 768ms

 Test Files  1 passed (1)
      Tests  12 passed (12)
   Start at  15:20:06
   Duration  3.75s (transform 1.24s, setup 13ms, collect 1.89s, tests 1.68s, environment 0ms, prepare 46ms)

```

```text
$ cd packages/sdk && npx vitest run tests/cli.test.ts tests/preflight.test.ts tests/cli-watch.test.ts tests/relay-cli-surface.test.ts

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ✓ tests/relay-cli-surface.test.ts (88 tests) 105ms
 ✓ tests/preflight.test.ts (70 tests) 198ms
 ✓ tests/cli.test.ts (71 tests) 3586ms
   ✓ flows check CLI > binds a checked relative wrapper to the flow directory for worker execution 888ms
   ✓ flows check CLI > resolves a bare PATH-resolved claude with no declared model, in an isolated PATH 534ms
   ✓ flows run/resume CLI over the journal protocol > follows a worker wait past a locally expired lease until the daemon settles it 1040ms
 ✓ tests/cli-watch.test.ts (10 tests) 16133ms
   ✓ flows check --watch > rechecks syntax errors, clears once, and returns the last refusal on Ctrl-C 1590ms
   ✓ flows check --watch > streams JSON lines without ANSI, recovers after atomic saves, and exits zero after repair 1848ms
   ✓ flows check --watch > coalesces 20 concurrent saves into at most two rechecks 1809ms
   ✓ flows check --watch > watches transitive relative use imports, cycles, and nearest config changes 2287ms
   ✓ flows check --watch > refreshes the import graph and notices missing imports being created 2358ms
   ✓ flows check --watch > reloads authored TypeScript instead of reusing the first imported definition 1833ms
   ✓ flows check --watch > detects a nearer config appearing and falls back after it is deleted 1832ms
   ✓ flows check --watch > keeps watching after the target is deleted and recreated 1800ms
   ✓ flows check --watch > queues changes during a slow check without overlapping checks 773ms

 Test Files  4 passed (4)
      Tests  239 passed (239)
   Start at  15:20:21
   Duration  20.60s (transform 2.80s, setup 202ms, collect 10.08s, tests 20.02s, environment 1ms, prepare 323ms)

```

The ten-step demonstration fixture (outside the checkout) was:

```yaml
version: '0.1.0'
name: many
steps:
  - id: s1
    type: deterministic
    command: 'node -e "0"'
  - id: s2
    type: deterministic
    command: 'node -e "0"'
  - id: s3
    type: deterministic
    command: 'node -e "0"'
  - id: s4
    type: deterministic
    command: 'node -e "0"'
  - id: s5
    type: deterministic
    command: 'node -e "0"'
  - id: s6
    type: deterministic
    command: 'node -e "0"'
  - id: s7
    type: deterministic
    command: 'node -e "0"'
  - id: s8
    type: deterministic
    command: 'node -e "0"'
  - id: s9
    type: deterministic
    command: 'if [ -f x ]; then printf found; fi'
  - id: s10
    type: deterministic
    command: 'definitely-not-a-real-binary'
```

Its sibling `/tmp/foldcheck/flows.json` contains `{}`.

```text
$ node packages/sdk/dist/cli.js check /tmp/foldcheck/many.flow.yaml
WARNING [command_unresolved] Step "s10" command "definitely-not-a-real-binary" does not resolve as an executable; it runs only if the shell supplies it.
WARNING [editor_schema_missing] For editor validation, add this first line: # yaml-language-server: $schema=https://schema.relayflows.dev/v0.1/flows.schema.json
WARNING [unprovable_effects] 9 of 10 steps have effects that cannot be proven before execution (rerun with --explain-warnings to list them).
GATE step "s1" exit_code from data (kernel, journal-replayable)
GATE step "s2" exit_code from data (kernel, journal-replayable)
GATE step "s3" exit_code from data (kernel, journal-replayable)
GATE step "s4" exit_code from data (kernel, journal-replayable)
GATE step "s5" exit_code from data (kernel, journal-replayable)
GATE step "s6" exit_code from data (kernel, journal-replayable)
GATE step "s7" exit_code from data (kernel, journal-replayable)
GATE step "s8" exit_code from data (kernel, journal-replayable)
GATE step "s9" exit_code from data (kernel, journal-replayable)
GATE step "s10" exit_code from data (kernel, journal-replayable)
CHECK PASSED /tmp/foldcheck/many.flow.yaml
```

```text
$ node packages/sdk/dist/cli.js check --explain-warnings /tmp/foldcheck/many.flow.yaml
WARNING [unprovable_effects] Step "s1" command "node" resolves, but its effects cannot be proven before execution.
WARNING [unprovable_effects] Step "s2" command "node" resolves, but its effects cannot be proven before execution.
WARNING [unprovable_effects] Step "s3" command "node" resolves, but its effects cannot be proven before execution.
WARNING [unprovable_effects] Step "s4" command "node" resolves, but its effects cannot be proven before execution.
WARNING [unprovable_effects] Step "s5" command "node" resolves, but its effects cannot be proven before execution.
WARNING [unprovable_effects] Step "s6" command "node" resolves, but its effects cannot be proven before execution.
WARNING [unprovable_effects] Step "s7" command "node" resolves, but its effects cannot be proven before execution.
WARNING [unprovable_effects] Step "s8" command "node" resolves, but its effects cannot be proven before execution.
WARNING [unprovable_effects] Step "s9" starts with the shell reserved word "if", whose effects cannot be proven before execution.
WARNING [command_unresolved] Step "s10" command "definitely-not-a-real-binary" does not resolve as an executable; it runs only if the shell supplies it.
WARNING [editor_schema_missing] For editor validation, add this first line: # yaml-language-server: $schema=https://schema.relayflows.dev/v0.1/flows.schema.json
GATE step "s1" exit_code from data (kernel, journal-replayable)
GATE step "s2" exit_code from data (kernel, journal-replayable)
GATE step "s3" exit_code from data (kernel, journal-replayable)
GATE step "s4" exit_code from data (kernel, journal-replayable)
GATE step "s5" exit_code from data (kernel, journal-replayable)
GATE step "s6" exit_code from data (kernel, journal-replayable)
GATE step "s7" exit_code from data (kernel, journal-replayable)
GATE step "s8" exit_code from data (kernel, journal-replayable)
GATE step "s9" exit_code from data (kernel, journal-replayable)
GATE step "s10" exit_code from data (kernel, journal-replayable)
CHECK PASSED /tmp/foldcheck/many.flow.yaml
```

```text
$ node packages/sdk/dist/cli.js check --json /tmp/foldcheck/many.flow.yaml 2>/tmp/warning-json-stderr.log | jq '[.diagnostics[].kind] | group_by(.) | map({(.[0]): length}) | add'
{
  "command_unresolved": 1,
  "editor_schema_missing": 1,
  "unprovable_effects": 9
}
```

```text
$ node packages/sdk/dist/cli.js check testdata/hello-deterministic.flow.yaml
WARNING [editor_schema_missing] For editor validation, add this first line: # yaml-language-server: $schema=https://schema.relayflows.dev/v0.1/flows.schema.json
WARNING [unprovable_effects] 2 of 2 steps have effects that cannot be proven before execution (rerun with --explain-warnings to list them).
GATE step "greet" exit_code+output_contains from data (kernel, journal-replayable)
GATE step "shout" exit_code+output_contains from data (kernel, journal-replayable)
CHECK PASSED testdata/hello-deterministic.flow.yaml
```

```text
$ node packages/sdk/dist/cli.js check testdata/hello-llm.flow.yaml
WARNING [editor_schema_missing] For editor validation, add this first line: # yaml-language-server: $schema=https://schema.relayflows.dev/v0.1/flows.schema.json
WARNING [unprovable_effects] 2 of 3 steps have effects that cannot be proven before execution (rerun with --explain-warnings to list them).
GATE step "greet" exit_code+output_contains from data (kernel, journal-replayable)
GATE step "answer" json_schema from data (kernel, journal-replayable)
GATE step "finish" exit_code from data (kernel, journal-replayable)
RESOLVED step "answer" cli "./preflight/authenticated-cli" from project (/home/daytona/.relayflow-v2-supervisor/durable/repository/testdata/flows.json) model "deterministic-test-stub" from step
REQUIRES claude (step "answer")
CHECK PASSED testdata/hello-llm.flow.yaml
```

```text
$ node packages/sdk/dist/cli.js check testdata/hello-agent.flow.yaml
WARNING [permissions_unenforced] Step "edit" declares permissions (fileGlobs, accessPreset). This declaration is validated and recorded with the step spec; it is not currently enforced (gate 8 / #442). These permissions do not restrict file or network access.
WARNING [editor_schema_missing] For editor validation, add this first line: # yaml-language-server: $schema=https://schema.relayflows.dev/v0.1/flows.schema.json
WARNING [unprovable_effects] 2 of 3 steps have effects that cannot be proven before execution (rerun with --explain-warnings to list them).
GATE step "greet" exit_code+output_contains from data (kernel, journal-replayable)
GATE step "edit" output_contains from data (kernel, journal-replayable)
GATE step "finish" exit_code from data (kernel, journal-replayable)
RESOLVED step "edit" cli "./preflight/authenticated-cli" from project (/home/daytona/.relayflow-v2-supervisor/durable/repository/testdata/flows.json) model "test-model-v1" from step
REQUIRES claude (step "edit")
WARNING [agent_worker_unresolved] 1 agent step ("edit") requires an attached worker. For a local run, use `flows run --local-agent <flow>`, unless you already attach an agent worker for this daemon. `flows check` does not verify worker attachment: with no worker attached the run parks at the first agent step.
CHECK PASSED testdata/hello-agent.flow.yaml
```

JSON stderr captured by the command above:

```text
WARNING [command_unresolved] Step "s10" command "definitely-not-a-real-binary" does not resolve as an executable; it runs only if the shell supplies it.
WARNING [editor_schema_missing] For editor validation, add this first line: # yaml-language-server: $schema=https://schema.relayflows.dev/v0.1/flows.schema.json
WARNING [unprovable_effects] 9 of 10 steps have effects that cannot be proven before execution (rerun with --explain-warnings to list them).
```
