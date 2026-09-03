# PR #136 Signoff A — structure / integration

Reviewed: 2026-09-02

Exact head: `3f129ba1ef955252c1a71efff0473384b6a47370`

Baseline: merged `main` `a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2`

Scope: fresh-context, assessment-only structural signoff of the requested head.
No product or gate files were edited, and no push, merge, or release was
performed. I read `AGENTS.md` and RFC-0001 in full, inspected the complete PR
history/diff, and read the prior PR #136 findings and repair reports.

VERDICT: FINDINGS

## Finding FSA-136-01

- finding_id: `FSA-136-01`
- severity: `P1`
- file: `sdk/src/worker-cli.ts:34-36,90-93`
- issue: The new one-process custom-wrapper session prevents ambient
  `RELAYFLOW_MODEL` and `RELAYFLOW_WAKE_CONTEXT` from crossing, but it clones
  and supplies all remaining parent environment variables to the untrusted
  custom-wrapper process. Consequently an arbitrary ambient secret reaches the
  wrapper before it identifies, and can be exfiltrated independently of the
  stdin handshake. This violates the requested no-ambient-secret-leakage
  property and RFC-0001 Gate 8's "no ambient env inheritance" requirement.
  It means the model/wake handshake is private only with respect to those two
  variable names, not the worker's ambient credentials.
- fix_required: Construct the custom-wrapper environment from an explicit,
  documented non-secret allowlist rather than `{ ...process.env }`; do not
  reintroduce credentials through another inherited variable. Deliver
  instruction, declared model, and wake context only through the already
  identified stdin session.
- test_required: Add a worker-wrapper test that sets a controlled unrelated
  sentinel secret in the parent environment and proves it is absent both at
  identification and after the execute acknowledgement. Keep the existing
  symlink-retarget test, which pins that the identified child—not a second
  pathname lookup—receives the request.
- evidence:

  ```text
  $ nl -ba sdk/src/worker-cli.ts | sed -n '20,90p'
      27  export async function runAgentCli(
      33    const kind = cliAdapterKind(cli);
      34    const env: NodeJS.ProcessEnv = { ...process.env };
      35    delete env[WAKE_CONTEXT_ENV];
      36    delete env[MODEL_ENV];
      38    if (kind === 'relayflows-wrapper-v1') {
      39      return runWrapperSession(cli, instruction, wakeContext, model, env);
      61   * Custom wrappers identify and execute within one child process. Private
      62   * values are withheld from argv/env and sent over stdin only after that exact
      63   * process emits the identity token. A second acknowledgement proves it parsed
      90    const child = spawn(cli, [WRAPPER_IDENTIFY_ARG], {
      91      stdio: ['pipe', 'pipe', 'pipe'],
      92      env,
      93    });

  $ ./node_modules/.bin/vite-node /tmp/pr136-ambient-wrapper.ts
  {"exit_code":0,"stdout_tail":"{\"secretAtIdentify\":\"controlled-signoff-sentinel\",\"instruction\":\"private instruction\",\"model\":\"private-model\",\"wake\":{\"private\":\"wake\"}}","stderr_tail":""}
  ```

  The controlled temporary wrapper emitted `secretAtIdentify` before it read
  the stdin request. The temporary probe file and its temporary wrapper
  directory were removed immediately after the command.

## Checks that passed (but do not cure FSA-136-01)

### Pure whole-flow static phase and ordering

`preflight` validates the raw complete spec, runs pure model-registry checks,
then resolves every non-deterministic step before it calls a command, CLI/model,
or trigger probe (`sdk/src/preflight.ts:101-150`). This repairs the P1 in the
prior `20260902-2048-pr136-structure.md`: an unresolved CLI in either position
now returns with no probes, including deterministic-command and trigger probes.
Schema validation covers malformed command/trigger/model/CLI declarations in
the same no-I/O pass.

```text
$ ./node_modules/.bin/vitest run tests/preflight.test.ts -t 'collects every static CLI refusal before every probe' --reporter=verbose --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-pr136-signoff-b-wt/sdk

 ✓ tests/preflight.test.ts > preflight: CLI resolution and refusal predicates > collects every static CLI refusal before every probe: unresolved first
 ✓ tests/preflight.test.ts > preflight: CLI resolution and refusal predicates > collects every static CLI refusal before every probe: unresolved last

 Test Files  1 passed (1)
      Tests  2 passed | 22 skipped (24)
   Start at  21:42:42
   Duration  13.51s (transform 5.35s, setup 0ms, collect 6.78s, tests 45ms, environment 1ms, prepare 2.84s)
```

### Raw/named precedence and journaled model provenance

The authoring map remains through preflight; `toKernelSpec` resolves the named
selector exactly once. Inline CLI and model each independently override the
selected named declaration, while the selected named declaration overrides only
the CLI fallback (`sdk/src/compile.ts:139-162`; `sdk/src/preflight.ts:236-245`).
The map/selector remain authoring sugar and the resolved `model` is included in
the existing kernel step, which is captured in `run.spawned` by the live-kernel
test at `sdk/tests/live-kernel.test.ts:705-771`; no kernel vocabulary or
journal-version change appears in this PR.

```text
$ git diff --name-only a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2...3f129ba1ef955252c1a71efff0473384b6a47370 -- kernel | wc -l | tr -d ' '
0
$ git show a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2:kernel/relayflowd-core/src/lib.rs | rg -o 'JOURNAL_VERSION: u32 = [0-9]+'
JOURNAL_VERSION: u32 = 1
$ git show 3f129ba1ef955252c1a71efff0473384b6a47370:kernel/relayflowd-core/src/lib.rs | rg -o 'JOURNAL_VERSION: u32 = [0-9]+'
JOURNAL_VERSION: u32 = 1
```

### One-process wrapper identity and private handshake

The worker spawns exactly one child, sends the request only after that child
emits the identity token, and waits for a second execute acknowledgement
(`sdk/src/worker-cli.ts:90-159`). The symlink-retarget test demonstrates that a
post-identification pathname retarget cannot redirect the already-running
child; it also proves model/wake ambient values are scrubbed. Its restricted
property passes, but it did not test unrelated inherited secret variables and
therefore did not expose FSA-136-01.

```text
$ git rev-parse HEAD && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run tests/preflight.test.ts tests/model-selection.test.ts tests/worker-cli.test.ts tests/cli.test.ts --reporter=dot --maxWorkers=1 --minWorkers=1
3f129ba1ef955252c1a71efff0473384b6a47370

 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-pr136-signoff-b-wt/sdk

 ✓ tests/cli.test.ts (63 tests) 4697ms
 ✓ tests/preflight.test.ts (24 tests) 40ms
 ✓ tests/model-selection.test.ts (10 tests) 35ms
 ✓ tests/worker-cli.test.ts (1 test) 302ms

 Test Files  4 passed (4)
      Tests  98 passed (98)
   Start at  21:39:41
   Duration  8.77s (transform 500ms, setup 0ms, collect 1.11s, tests 5.07s, environment 1ms, prepare 677ms)
```

### Real provider adapters, including non-Git Codex

Claude accepted the exact requested model. Codex executed the exact declared
model under the production worker argv shape from a fresh directory without a
`.git` directory, confirming the non-Git flag is effective.

```text
$ claude -p --model claude-haiku-4-5-20251001 --tools '' --no-session-persistence 'Reply with exactly PR136_CLAUDE_READY.'
PR136_CLAUDE_READY

$ codex exec --ephemeral --skip-git-repo-check --model gpt-5.6-sol 'Reply with exactly PR136_CODEX_NON_GIT_READY.'
PR136_CODEX_NON_GIT_READY
PR136_CODEX_NON_GIT_READY
tokens used
8,919
PWD=/tmp/pr136-real-codex-signoff.4Z110z
GIT_DIR_PRESENT=no
```

### v0.1.0 compatibility

The v0.1.0 schema remains the sole supported authoring version and the kernel
`model` field remains optional. Existing no-model flows retain an absent model;
the focused suite above includes the complete 63-case CLI v0.1.0 surface and
the 24-case preflight suite. No new kernel field, journal entry, or journal
version was introduced by this head.

## Deterministic evidence and limits

The review worktree intentionally has no `sdk/node_modules`; tests were run in
the sibling signoff worktree only after its `git rev-parse HEAD` printed the
same requested SHA above. The commands and their literal output are included
here. A full real-adapter Vitest run was started but exceeded the command
capture window after its `RUN` banner, so this report does not claim that suite
as rerun; the direct successful Claude and non-Git Codex executions above are
the fresh real-adapter evidence.

## Remaining risks

FSA-136-01 is a merge blocker. Until the wrapper environment is allowlisted
and negatively tested, an untrusted custom wrapper can read host credentials
that the declared flow did not authorize it to receive.
