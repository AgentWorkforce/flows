# Add recoverable agent execution timeouts

An optional repair agent could consume a flow's remaining wallclock budget and
prevent publishing. `f.agent(..., { timeout: '45m' })` now stops its CLI process
group at the declared deadline and journals `completionReason: 'timeout'`.
Following the reviewed plan, this **resolves** with an `AgentResult` containing
`completionReason: 'timeout'`; authors branch on that result to continue. It
does not throw a catchable exception, because caught step failures otherwise
poison the authored operation and budget. Omission retains unlimited execution.

- Maximum: 60m at authoring/SDK validation, giving measured 44m09s repairs about
  35% headroom. YAML uses integer `timeoutMs`; the journal uses `timeout_ms`.
  The kernel checks positive/i64 bounds; it does not enforce the SDK ceiling.
- Native Claude/Codex and wrapper execution share the existing stop machinery.
  Only a wrapper execution deadline receives timeout evidence; protocol errors
  remain failures. Workspace edits and commits are not reset. Resume replays
  the timed-out child without dispatching it again.
- Timeout resolves inside budget consumption, after journal indexing. Failed
  index writes still fail closed. IPC acceptance requires an explicit timeout
  declaration, settled timeout evidence, and the matching failed child state.
- Predicate gates run on timed-out results. Named data gates that cannot run
  because their producer timed out still fail the operation. The failed child
  remains visible as failed while the authored flow can finish successfully;
  `SURFACE.md` explicitly amends its caught-failure rule for this exception.

Reviewed-plan choices: refuse `maxIterations > 1` with a timeout (B2 option b)
and refuse relay transport, rather than declare a bound those paths cannot
honor. Transport recovery before timeout can still start a fresh CLI timer.
Keep `artifacts: []` on timeout (C2 option i), documenting the native journal's
bounded artifact paths and the wrapper transcript gap. No kernel failure-output
change. The trailing `runAgentCli` argument preserves existing positional
callers. Authored validation reuses `agent_cli_unresolved`.

This deliberately extends the former deterministic-only `timeoutMs` rule to
agents while keeping timeout fields per verb; LLM declarations remain unchanged.
Agent validation includes a maximum, unlike deterministic `timeoutMs`. Older
daemons reject the new field and older workers do not enforce it, so deploy
matching versions. No dollar-budget enforcement, Garden generator changes,
wrapper default cap, or workflow-file changes are included.

Verification commands and full captured output, including the initial failures
and their environment diagnosis, are in [the evidence index](evidence/agent-timeout/README.md).

Final SDK regression output ([command and full output](evidence/agent-timeout/README.md)):

```text
 Test Files  13 passed (13)
      Tests  316 passed (316)
```

This includes real CLI termination, retained workspace content, following `f.run`
under a budget header, predicate-gate handling, root/daemon kill and resume,
undeclared timeout refusal, failed journal indexing, IPC forgery rejection,
option validation/lowering, and existing lease/process-group/wrapper regressions.

Kernel command: `sh ops/cargo.sh test --manifest-path kernel/Cargo.toml -p relayflowd-core`
([full captured output](evidence/agent-timeout/kernel.txt)):

```text
test result: ok. 86 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.71s
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
test result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s
```

Schema command: `npm test --prefix packages/schema`
([full captured output](evidence/agent-timeout/schema-tests.txt)):

```text
 85 pass
 0 fail
 4019 expect() calls
Ran 85 tests across 2 files. [2.31s]
```

SDK source and test typechecks have no diagnostics; their literal commands and
captured output are linked in the evidence index. This work is not described as
mutation-verified.

Broader live-kernel command (changed code, isolated checkout to avoid the parent
CommonJS package scope):

```sh
cd /tmp/agent-timeout-baseline/packages/sdk && RELAYFLOWD_BIN=/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 ./node_modules/.bin/vitest run tests/live-kernel.test.ts
```

[Captured output](evidence/agent-timeout/isolated-live-kernel.txt):

```text
 Test Files  1 failed (1)
      Tests  1 failed | 31 passed (32)
```

The remaining real Claude analyzer test reports `execution/fail` instead of
`json_schema/pass`. It also fails against the original `c88c3d0` surface/SDK
using the same daemon:

```sh
cd /tmp/agent-timeout-original/packages/sdk && RELAYFLOWD_BIN=/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd ./node_modules/.bin/vitest run tests/live-kernel.test.ts -t 'hn-monitor analyze-story reaches done through the real Claude analyzer CLI'
```

[Captured original-head output](evidence/agent-timeout/original-analyzer.txt):

```text
 Test Files  1 failed (1)
      Tests  1 failed | 31 skipped (32)
```

That existing live-provider failure remains unresolved; no gate was weakened or
changed to make it pass.
