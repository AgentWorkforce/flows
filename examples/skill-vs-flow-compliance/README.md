# skill-vs-flow-compliance

A worked comparison of a coding agent with an installed skill, a bare
agent, and a flow that runs deterministic checks after the agent and
allows one repair attempt. The contrast is **advisory instructions versus
an enforced final-state acceptance check**. This example does not establish
that the agent followed every instruction in the skill.

## What is measured

The historical [skill](SKILL.md) asks for test-first development, no debug
leftovers, no secrets, and conventional commits. All three arms are scored
by the same four scripts, which measure narrower properties:

| Script | Measured property | What a pass does not establish |
|---|---|---|
| `check-tests-pass` | A committed `test/*.test.ts` file changed and `npm test` passes | Test-first ordering, adequate coverage, or task correctness |
| `check-no-debug-artifacts` | No matching debug patterns in added TypeScript lines | Absence of every form of debug code |
| `check-no-secrets` | No matching credential patterns in added lines | A comprehensive secret scan |
| `check-commit-message` | Every subject since baseline matches the allowed types, optional scope, and nonempty subject | Compliance with a stricter mandatory-scope policy |

The skill's test-first requirement is **not equivalent** to the first
check. A test added after implementation can pass; the captured no-skill
trials include that behavior. A successful repair cannot retroactively
make an implementation test-first. All counts below mean **passes these
four checks**, not full skill compliance.

The updated harness also requires a clean working tree before running the
suite (excluding Git-ignored host settings), so a passing uncommitted repair cannot conceal a failing committed
tree. The scans still inspect committed changes. Trial agents can edit
tests and package scripts; these checks are not a tamper-proof oracle or
an independent acceptance test for the calculator task.

## Captured observations

These are historical model executions retained from the original example.
Each linked directory contains prompts, transcripts, a final patch, commit
subjects, and verdicts. Transcript initialization metadata, home-directory identifiers, emails,
and Git/listing author fields have been redacted; task actions and outcomes remain. They are not new
model executions made with the repaired harness.

| Scenario | Agent + installed skill | Bare agent | Flow final result | Flow repair needed |
|---|---|---|---|---|
| Trivial divide fix, default model | [3/3 checks pass](runs/agent-plus-skill/) | [3/3 checks pass](runs/agent-no-skill/) | [3/3 `success`](runs/relayflow/) | 1/3 |
| Four-part task, `--model haiku` | [0/3 checks pass](runs/agent-plus-skill-hard/) | [0/3 checks pass](runs/agent-no-skill-hard/) | [3/3 `success`](runs/relayflow-hard/) | 3/3 |

In the harder scenario, all six single-shot agent results and all three
first flow attempts report `check-tests-pass` failure because no test file
changed. Some also fail commit formatting. Each flow's second attempt
reports all checks passing. The flow records the failure and gives its
messages to the repair agent before deciding whether to return success;
see the [first hard run's verdict](runs/relayflow-hard/run-1/verdict.json)
and [repair prompt](runs/relayflow-hard/run-1/attempt-2-implementer.prompt.md).
A second failed check set throws `GateFailed` with `completionReason:
gate_failed`, rather than returning success.

The easy skill-arm transcripts contain one `Skill` tool call each; the
hard skill-arm transcripts contain none. This establishes invocation
counts, not what the model discovered internally or why it chose not to
invoke the skill. Task and model changed together, so their effects are
confounded. Three trials per arm do not establish a population rate,
statistical equivalence, or a causal effect attributable solely to skill
availability. The flow also gets extra feedback and up to a second model
call: the experiment does not separate the effect of feedback from that
additional budget. Gates enforce acceptance; they do not guarantee that a
repair will succeed.

The additional [nudged skill arm](runs/agent-plus-skill-hard-nudged/)
uses the hard task and Haiku, with a request to check for applicable
project skills appended to the prompt (`--nudge-skill`). All three captured
trials invoke `Skill` once and pass all four checks. That observation
qualifies the unprompted arm's gap: prompting for skill use also produced
passing final states in this sample. It does not prove full skill
compliance, force future discovery, or isolate discovery from the other
effects of changing the prompt. The nudged arm has a different initial
prompt from the bare and flow arms.

The original easy prompt used `git add -A`. Several resulting patches
include `.claude/settings.json`. Three final patches keep a stale test-gap
comment despite adding the test: [bare trial 2](runs/agent-no-skill/trial-2/diff.patch),
[flow run 1](runs/relayflow/run-1/diff.patch), and
[flow run 2](runs/relayflow/run-2/diff.patch). Both flow runs report success.
Those are real deficiencies in the agent output which these four checks
did not detect. The patches and historical prompts are preserved rather
than edited into a cleaner outcome. Treat them as evidence, not settings
to install. Future prompts stage only task files, and future trial commits
use a fixture-local anonymous Git identity. New trial repositories exclude
`.claude/settings.json` via `.git/info/exclude`, so obeying the scoped
staging instruction does not leave a gate-blocking tool-settings file.
The installed skill remains tracked.

## Verify the artifacts and control flow

Run from the repository root with Node >=22.6.0:

```sh
node --experimental-strip-types --test examples/skill-vs-flow-compliance/shims/runtime.test.ts
node --experimental-strip-types examples/skill-vs-flow-compliance/shims/audit-evidence.ts
npm --prefix examples/skill-vs-flow-compliance run typecheck
```

The typecheck requires SDK dev dependencies (`npm install --prefix
packages/sdk --ignore-scripts`). [VERIFICATION.md](VERIFICATION.md) contains
the literal commands and captured output. The tests exercise a compliant
and a violating tree, empty scans, invalid baseline, reuse refusal,
uncommitted repairs, evidence capture, redaction, and the flow's first-pass,
repair, and terminal-failure branches. These are deterministic tests, not
live model trials or mutation verification.

The artifact audit applies each captured final patch to a fresh fixture
and reconstructs commit **subjects** to rerun the four checks. It does not
recreate historical commit hashes or intermediate attempt trees, rerun a
model, or establish test-first ordering. The historical `attemptHistory`
remains a recorded observation; only final trees are reconstructed.

## Run new model trials

An authenticated `claude` CLI is required. Each command makes one or two
billed model calls. Use a new trial/run ID: existing evidence directories
are refused, including in a fresh clone where the ignored trial repo is
absent.

```sh
cd examples/skill-vs-flow-compliance

node --experimental-strip-types shims/run-agent-trial.ts --trial 4
node --experimental-strip-types shims/run-agent-trial.ts --trial 4 --no-skill
node --experimental-strip-types shims/run-flow.ts --run 4

node --experimental-strip-types shims/run-agent-trial.ts --trial 4 --task TASK-HARD.md --model haiku --scenario hard
node --experimental-strip-types shims/run-agent-trial.ts --trial 4 --no-skill --task TASK-HARD.md --model haiku --scenario hard
node --experimental-strip-types shims/run-flow.ts --run 4 --task TASK-HARD.md --model haiku --scenario hard
node --experimental-strip-types shims/run-agent-trial.ts --trial 4 --task TASK-HARD.md --model haiku --scenario hard-nudged --nudge-skill
```

The skill arm installs `SKILL.md` at
`.claude/skills/engineering-conventions/SKILL.md`; the other arms do not.
Without `--nudge-skill`, the initial task text is identical across arms within a scenario. The
current task files include scoped staging instructions added after the
historical runs, so new invocations are not exact replications of their
prompts. Model aliases and host settings can also change.

## Runtime scope

`compliance-flow.ts` is an illustrative v2-style flow with local types;
`shims/run-flow.ts` executes it in userland. It does not execute through
the Rust journal, prove durability, or validate compatibility with the
real authored executor. Its aggregate gate collects all four failures
before deciding whether to retry. This example does not call postfix
`.gate()` in its flow body. The real executor's unsupported gate operation
is documented separately in `packages/sdk/src/authored-flow-operation.ts`.

The Claude invocation bypasses permission prompts. The trial directory
is organizational isolation, not filesystem containment: the agent can
reach files outside it, including the example scripts. Shared host
configuration may influence skill discovery and task execution. Metadata
redaction minimizes known identifiers; it is not a general secret scanner.

```text
skill-vs-flow-compliance/
  TASK.md, TASK-HARD.md      current task prompts
  SKILL.md                  historical skill, unchanged
  fixture/                  calculator repository template
  checks/                   four final-state scripts
  compliance-flow.ts        agent, checks, bounded retry, terminal decision
  shims/                    execution, artifact audit, regression tests
  runs/                     historical evidence (trial repo/ is ignored)
  VERIFICATION.md           captured deterministic verification
```
