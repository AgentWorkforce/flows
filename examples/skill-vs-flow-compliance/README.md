# skill-vs-flow-compliance

**The comparison the RelayFlow value prop rests on:** the same tiny coding
task, run for real, three ways — an agent with a skill, an agent with no
skill, and a relayflow that encodes the skill's rules as postfix
deterministic gates instead of handing them to the agent at all. All three
arms are real invocations of `claude` (Opus), not simulated. Every number
below links to the literal captured evidence that produced it.

**Like I'm 5:** you can write a note reminding a helper to double-check their
work, or you can build a machine that physically won't let the box ship
until it's been double-checked. Both usually work. This measures how often
"usually" isn't good enough, and what happens differently when it isn't.

## The four rules under test

`SKILL.md` (installed as a real Claude Code project skill at
`.claude/skills/engineering-conventions/` in arm A's trial repos) states four
house conventions: test-first, no debug leftovers, no secrets, conventional
commit messages. `checks/*.sh` are the same four rules as deterministic
shell scripts — no LLM anywhere — scored against a git diff. **The same four
scripts are the ground truth for all three arms**: they score arm A's
finished diff after the fact, and they are literally the steps
`compliance-flow.ts` runs *during* arm B's run, before it is allowed to
finish. Sanity-checked against a hand-built compliant diff (all four PASS)
and a hand-built violating diff (all four correctly FAIL) — see the smoke
test in this PR's evidence, not re-included here since it isn't a trial.

## The task

`TASK.md`, verbatim, identical across every arm: fix `divide()` in
`fixture/src/calculator.ts` so it throws on division by zero instead of
returning `Infinity`/`NaN`. No arm is told about the four rules in its task
prompt — arm A's agent has to notice the installed skill applies and choose
to invoke it; the flow never mentions the rules to its agent at all.

## Arm A — agent + skill (`shims/run-agent-trial.ts`)

Single-shot: the skill is installed, the agent gets the bare task, and
whatever it produces is scored once, after the fact — exactly like a human
reviewing a finished PR. Nothing intervenes mid-task.

| Trial | Skill invoked? | tests-pass | no-debug | no-secrets | commit-msg | Evidence |
|---|---|---|---|---|---|---|
| 1 | yes | PASS | PASS | PASS | PASS | [transcript](runs/agent-plus-skill/trial-1/transcript.txt) · [diff](runs/agent-plus-skill/trial-1/diff.patch) · [verdict](runs/agent-plus-skill/trial-1/verdict.json) |
| 2 | yes | PASS | PASS | PASS | PASS | [transcript](runs/agent-plus-skill/trial-2/transcript.txt) · [diff](runs/agent-plus-skill/trial-2/diff.patch) · [verdict](runs/agent-plus-skill/trial-2/verdict.json) |
| 3 | yes | PASS | PASS | PASS | PASS | [transcript](runs/agent-plus-skill/trial-3/transcript.txt) · [diff](runs/agent-plus-skill/trial-3/diff.patch) · [verdict](runs/agent-plus-skill/trial-3/verdict.json) |

**3/3 trials fully compliant; the `Skill` tool fired in all 3** (`grep -c
'"name":"Skill"' runs/agent-plus-skill/trial-*/transcript.txt` → `1` each).
On this small, single-concern task, the skill worked every time it was
tried.

## Arm A-control — agent, no skill installed (same shim, `--no-skill`)

Same task, same model, same shim — `.claude/skills/` is simply absent from
the repo. Isolates the skill's marginal effect from the model's baseline
competence.

| Trial | tests-pass | no-debug | no-secrets | commit-msg | Evidence |
|---|---|---|---|---|---|
| 1 | PASS | PASS | PASS | PASS | [verdict](runs/agent-no-skill/trial-1/verdict.json) |
| 2 | PASS | PASS | PASS | PASS | [verdict](runs/agent-no-skill/trial-2/verdict.json) |
| 3 | PASS | PASS | PASS | PASS | [verdict](runs/agent-no-skill/trial-3/verdict.json) |

**3/3 also fully compliant.** A frontier model's own defaults on a task this
small are already decent — the skill's marginal contribution isn't visible
in this sample. Reported anyway, per this repo's evidence rule: a smaller
true claim beats a larger one that doesn't survive being checked. Keep
reading — the same bare setup looks different inside the flow.

## Arm B — the relayflow (`compliance-flow.ts` + `shims/run-flow.ts`)

The agent gets the identical bare task — no skill installed, no mention of
the four rules. The difference is what happens next: the flow runs all four
checks as steps, and a run cannot reach `f.done("success")` while any of
them fail. One bounded retry (RFC-0001 §1's "semantic retry — verification
gates + bounded iteration"): a failing first attempt gets the gate's own
failure message fed back for exactly one repair turn, then the same four
checks run again. A second failure would end the run `gate_failed`, naming
the rule — every real run below happened to resolve within the retry, but
nothing about the mechanism assumes it will.

| Run | Attempt 1 | Attempt 2 | Final | Evidence |
|---|---|---|---|---|
| 1 | ALL PASS | — (not needed) | `success` | [verdict](runs/relayflow/run-1/verdict.json) · [attempt-1 log](runs/relayflow/run-1/attempt-1-implementer.txt) |
| 2 | ALL PASS | — (not needed) | `success` | [verdict](runs/relayflow/run-2/verdict.json) · [attempt-1 log](runs/relayflow/run-2/attempt-1-implementer.txt) |
| 3 | **FAIL: check-tests-pass** — "no test file changed since baseline" | ALL PASS | `success` | [verdict](runs/relayflow/run-3/verdict.json) · [repair prompt the gate generated](runs/relayflow/run-3/attempt-2-implementer.prompt.md) |

**3/3 final runs `success` — by construction, not by luck.** But look at
attempt 1, before the gate did anything: **1 of 3 bare first attempts
skipped writing a test** (run 3) — the same "no skill installed" setup as
arm A-control, same model, same task, and this time it missed. Pool all 6
bare single-shot invocations across arm A-control's 3 trials and the flow's
3 first attempts and the observed miss rate on the test-first rule is 1/6.
The honest reading isn't "the flow found a 17% failure rate" — six trials is
not a rate, and a rerun of this same example could as easily land 0/6 or
3/6. It's that **the same nondeterministic step that sometimes skips a test
cannot be trusted to never skip one**, and arm A has no mechanism to notice
when it does. Arm B's gate noticed it in real time, said exactly what was
wrong, and fixed it before reporting anything —
[see the actual repair prompt it generated](runs/relayflow/run-3/attempt-2-implementer.prompt.md).

## What this does and doesn't claim

- **This is not a statistical study.** N=3 per arm is a worked mechanism
  demo with real, checkable evidence, not a compliance-rate estimate. Don't
  read "1/3" or "3/3" above as a population rate for any model.
- **The skill genuinely worked, every time we invoked it.** This example
  does not claim skills are unreliable in general — the honest result here
  is closer to "a frontier model on a small, well-matched task follows both
  a skill and its own defaults most of the time." That is a real finding,
  and it undercuts a cheaper version of this pitch that assumes skills
  fail constantly. They don't have to, to matter.
- **The actual claim is about *kind*, not *rate*.** A skill is the agent
  choosing, from memory, to apply a rule it was told about once. A
  relayflow gate is a deterministic script that runs whether or not
  anything remembers to ask it to, and a run cannot report success while
  it's failing. At the scale RFC-0001's covenant 3 targets — ten, twenty,
  thirty concurrent runs — the difference between "usually" and "provably"
  is exactly the difference between an incident you find in a retro and one
  that never ships. Run 3's attempt 1 is what "usually" looks like from the
  inside: not a dramatic failure, a quietly skipped test, in a task nobody
  was watching. The gate is the only reason it didn't ship that way.

## Reproduce it

```sh
cd examples/skill-vs-flow-compliance

# Arm A: agent + skill (installed fresh into an isolated git repo per trial)
node --experimental-strip-types shims/run-agent-trial.ts --trial 4

# Arm A-control: same, no skill installed
node --experimental-strip-types shims/run-agent-trial.ts --trial 4 --no-skill

# Arm B: the relayflow (bare task, gate + bounded retry, no skill involved)
node --experimental-strip-types shims/run-flow.ts --run 4
```

Requires an authenticated `claude` CLI on `PATH` (`claude auth status`).
Each invocation makes one or two real, billed model calls and writes fresh
evidence under `runs/<arm>/`; nothing here is mocked or replayed. Trial/run
numbers are not reused — pick a fresh `--trial`/`--run` value or a prior
directory is left in place rather than silently overwritten.

Typecheck (opt-in, mirrors `examples/research`):

```sh
npm --prefix examples/skill-vs-flow-compliance run typecheck
```

## Files

```
examples/skill-vs-flow-compliance/
  TASK.md                the bare task, identical across every arm
  SKILL.md                the four house conventions, as a skill
  fixture/                the task repo template, copied fresh per trial/run
  checks/*.sh              the four rules as deterministic scripts — the shared ground truth
  compliance-flow.ts       arm B: the relayflow (v2 dialect, docs/SURFACE.md)
  shims/
    trial-runtime.ts       shared plumbing: materialize an isolated repo, run checks
    run-agent-trial.ts     arm A + arm A-control entry point
    run-flow.ts            arm B entry point — implements postfix .gate() in
                            userland, same documented gap as examples/research/shims/run.ts
  runs/                    captured evidence (gitignored: runs/**/repo/, the live git repos)
```

## Known limitations

- **Single CLI (Claude), single model (Opus, whatever the host resolves as
  default).** Unlike `examples/research`'s three-lane fan-out, this example
  doesn't vary the model — the question here is skill-vs-gate, not
  model-vs-model. Re-running against a smaller/cheaper model would be a
  natural follow-up and is expected to widen the gap this README reports as
  not visible yet.
- **No workspace containment.** Same limitation as `examples/research`:
  `--dangerously-skip-permissions` is real permission bypass, scoped only by
  the trial's isolated directory as a matter of task design, not by any
  kernel enforcement (that's gate 8).
- **The flow's `.gate()` runs in a userland shim, not the kernel.** Same
  documented gap as `examples/research`: the real authored executor
  (`packages/sdk/src/authored-flow-operation.ts`) throws `unsupported_gate`
  today. `compliance-flow.ts` typechecks as a v2-dialect flow; `shims/run-flow.ts`
  is what actually executes it, exactly the way `examples/research/shims/run.ts`
  already does for its own context.
