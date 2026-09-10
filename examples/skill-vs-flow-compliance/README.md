# skill-vs-flow-compliance

**The comparison the RelayFlow value prop rests on:** the same coding task,
run for real, three ways — an agent with a skill, an agent with no skill,
and a relayflow that encodes the skill's rules as postfix deterministic
gates instead of handing them to the agent at all. Every number below links
to the literal captured evidence that produced it.

**Like I'm 5:** you can write a note reminding a helper to double-check their
work, or you can build a machine that physically won't let the box ship
until it's been double-checked. Both usually work. This measures how often
"usually" isn't good enough, and what happens differently when it isn't.

**Two scenarios, on purpose, plus one follow-up that changed the story.**
Scenario 1 (trivial task, frontier model) came back near-parity across all
three arms — a real result, but not a compelling one, reported honestly as
exactly that below. Scenario 2 (harder task, cheaper model) found a real
gap: 0/3 final compliance without a gate, 3/3 with one. But the reason
turned out to matter: the skill's `Skill` tool never fired in Scenario 2 —
the agent didn't read the skill and disregard it, it never found the skill
at all. That's a different claim than "skills are followed unreliably," so
we ran a third variant, **Scenario 2b**, that forces discovery (a generic
"check for applicable project skills" nudge — no rule text pasted) and
re-measures compliance once the skill is actually read. Once discovery was
forced, compliance came back **3/3** — so the gap in Scenario 2 was a
discovery failure, not a follow-through failure, and the README below says
so plainly rather than keeping the more dramatic-sounding original framing.
See [Scenario 1](#scenario-1--trivial-task-frontier-model),
[Scenario 2](#scenario-2--harder-task-cheaper-model), and
[Scenario 2b](#scenario-2b--same-as-2-but-discovery-is-forced).

## The four rules under test

`SKILL.md` (installed as a real Claude Code project skill at
`.claude/skills/engineering-conventions/` in arm A's trial repos) states four
house conventions: test-first, no debug leftovers, no secrets, conventional
commit messages. `checks/*.sh` are the same four rules as deterministic
shell scripts — no LLM anywhere — scored against a git diff. **The same four
scripts are the ground truth for all three arms, in both scenarios below**:
they score arm A's finished diff after the fact, and they are literally the
steps `compliance-flow.ts` runs *during* arm B's run, before it is allowed
to finish. Sanity-checked against a hand-built compliant diff (all four
PASS) and a hand-built violating diff (all four correctly FAIL) — see the
smoke test in this PR's evidence, not re-included here since it isn't a
trial.

## Scenario 1 — trivial task, frontier model

`TASK.md`, verbatim, identical across every arm in this scenario: fix
`divide()` in `fixture/src/calculator.ts` so it throws on division by zero
instead of returning `Infinity`/`NaN`. No arm is told about the four rules
in its task prompt — arm A's agent has to notice the installed skill applies
and choose to invoke it; the flow never mentions the rules to its agent at
all. All three arms below are real invocations of `claude` at its default
model (Opus, whatever the host resolves), not simulated.

### Arm A — agent + skill (`shims/run-agent-trial.ts`)

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

### Arm A-control — agent, no skill installed (same shim, `--no-skill`)

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

### Arm B — the relayflow (`compliance-flow.ts` + `shims/run-flow.ts`)

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

## Scenario 2 — harder task, cheaper model

Same harness, same four ground-truth checks, same `claude` CLI — two things
changed, both away from the frontier model's comfort zone: `TASK-HARD.md`
replaces the one-line fix with four independent pieces of work in a single
pass (fix `divide`, add `average`, add `power`, add `NaN` guards to `add`
and `subtract`), and every invocation passes `--model haiku` instead of the
host's Opus default. `SKILL.md` is unchanged and still states "test-first...
on every change, however small." Reproduce with `--task TASK-HARD.md
--model haiku --scenario hard` on all three commands in
[Reproduce it](#reproduce-it).

### Arm A — agent + skill, Haiku, hard task

| Trial | Skill invoked? | tests-pass | no-debug | no-secrets | commit-msg | Evidence |
|---|---|---|---|---|---|---|
| 1 | **no** | FAIL | PASS | PASS | PASS | [transcript](runs/agent-plus-skill-hard/trial-1/transcript.txt) · [verdict](runs/agent-plus-skill-hard/trial-1/verdict.json) |
| 2 | **no** | FAIL | PASS | PASS | FAIL | [transcript](runs/agent-plus-skill-hard/trial-2/transcript.txt) · [verdict](runs/agent-plus-skill-hard/trial-2/verdict.json) |
| 3 | **no** | FAIL | PASS | PASS | PASS | [transcript](runs/agent-plus-skill-hard/trial-3/transcript.txt) · [verdict](runs/agent-plus-skill-hard/trial-3/verdict.json) |

**0/3 compliant. The `Skill` tool never fired** (`grep -c '"name":"Skill"'
runs/agent-plus-skill-hard/trial-*/transcript.txt` → `0` for all three,
against `1` for every Scenario 1 trial). It isn't (necessarily) that Haiku
read the skill and decided against it — the transcripts show it never
invoked the installed skill at all under the harder task, and did visibly
less verification work generally: one `Bash` call and one `Read` across the
whole trial, versus five `Bash` calls when the same skill fired for Opus in
Scenario 1 (`grep -c '"name":"Bash"' .../trial-1/transcript.txt`). That
"necessarily" matters — see Scenario 2b immediately below, which tests it
directly instead of leaving it as an inference from absence.

### Arm A-control — agent, no skill, Haiku, hard task

| Trial | tests-pass | no-debug | no-secrets | commit-msg | Evidence |
|---|---|---|---|---|---|
| 1 | FAIL | PASS | PASS | FAIL | [verdict](runs/agent-no-skill-hard/trial-1/verdict.json) |
| 2 | FAIL | PASS | PASS | PASS | [verdict](runs/agent-no-skill-hard/trial-2/verdict.json) |
| 3 | FAIL | PASS | PASS | PASS | [verdict](runs/agent-no-skill-hard/trial-3/verdict.json) |

**0/3 compliant — statistically indistinguishable from arm A with the skill
installed**, which is exactly what "the skill was never discovered" in arm A
predicts: an uninstalled skill and an undiscovered one look identical from
the outside. Every failure is the same rule, `check-tests-pass`: no test
file touched.

### Arm B — the relayflow, Haiku, hard task

| Run | Attempt 1 | Attempt 2 | Final | Evidence |
|---|---|---|---|---|
| 1 | **FAIL: check-tests-pass, check-commit-message** | ALL PASS | `success` | [verdict](runs/relayflow-hard/run-1/verdict.json) |
| 2 | **FAIL: check-tests-pass** | ALL PASS | `success` | [verdict](runs/relayflow-hard/run-2/verdict.json) |
| 3 | **FAIL: check-tests-pass, check-commit-message** | ALL PASS | `success` | [verdict](runs/relayflow-hard/run-3/verdict.json) |

**3/3 attempt-1s failed `check-tests-pass` — the identical root cause seen
in both agent arms, on the identical model, at the identical task.** That
match matters: it rules out "the flow's agent step just behaves
differently" as the explanation for what follows. The bounded retry, with
the gate's own failure message fed back, fixed all three: **3/3 final
`success`.**

**Scenario 2, side by side: 0/3 final compliance without a gate (either
arm), 3/3 with one — same task, same model, same failure mode, verified in
the transcripts, not asserted.** This is a real gap Scenario 1 didn't show.
But before treating it as "skills are unreliable," the honest next question
is *why* the agent arm failed — and Scenario 2's own transcripts already
answered that: the skill was never read. Scenario 2b tests the more
specific claim directly.

## Scenario 2b — same as 2, but discovery is forced

Identical to Scenario 2's agent+skill arm — same `TASK-HARD.md`, same
`--model haiku`, same installed `SKILL.md` — plus one line appended to the
prompt (`shims/run-agent-trial.ts`'s `SKILL_DISCOVERY_NUDGE`, via
`--nudge-skill`):

> Before you start, check whether this repository has any installed
> project skills that apply to this kind of change, and use whatever
> applies.

That sentence names no rule and pastes none of `SKILL.md`'s text — it only
tells the agent to check, the same standing instruction a team's own
`CLAUDE.md` commonly carries. This isolates discovery from compliance: if
the gap was "reads it, doesn't follow it," forcing discovery should still
show failures. If the gap was "never finds it," forcing discovery should
close it.

| Trial | Skill invoked? | tests-pass | no-debug | no-secrets | commit-msg | Evidence |
|---|---|---|---|---|---|---|
| 1 | **yes** | PASS | PASS | PASS | PASS | [transcript](runs/agent-plus-skill-hard-nudged/trial-1/transcript.txt) · [verdict](runs/agent-plus-skill-hard-nudged/trial-1/verdict.json) |
| 2 | **yes** | PASS | PASS | PASS | PASS | [transcript](runs/agent-plus-skill-hard-nudged/trial-2/transcript.txt) · [verdict](runs/agent-plus-skill-hard-nudged/trial-2/verdict.json) |
| 3 | **yes** | PASS | PASS | PASS | PASS | [transcript](runs/agent-plus-skill-hard-nudged/trial-3/transcript.txt) · [verdict](runs/agent-plus-skill-hard-nudged/trial-3/verdict.json) |

**It closed it: 3/3 discovered (`grep -c '"name":"Skill"'
runs/agent-plus-skill-hard-nudged/trial-*/transcript.txt` → `1` each), 3/3
fully compliant.** Same hard task, same cheap model, same four rules — the
only change from Scenario 2's 0/3 was forcing the agent to actually read the
skill. Once it did, on this sample, it followed all four rules every time,
including the harder task's extra surface area for missing one.

**What this changes about the claim:** Scenario 2's gap was real but was a
*discovery* failure, not a *compliance* failure — and those are different
things to fix. A compliance failure means the skill mechanism itself is
unreliable even when it works as designed. A discovery failure means the
mechanism worked fine once triggered, and the actual dependency is on
something *outside* the skill: either the model reliably noticing an
installed skill applies (which failed here, unprompted), or a human
correctly anticipating that and writing the right nudge into every task
prompt for every skill that might apply — which is the same "usually a
human remembers" reliance this whole comparison is about, just moved one
level up, from "will the agent follow the rule" to "will the agent (or a
human writing its prompt) even go looking for it." The relayflow gate has
no discovery step to fail, nudged or not, because it isn't something the
agent finds — it isn't agent-mediated at all.

## What this does and doesn't claim

- **Scenario 1 alone would not have proven the value prop.** A frontier
  model on a one-line task followed both the skill and its own defaults 3/3
  times — a real result, but parity, not a case for flows.
- **Scenario 2's 0/3 vs 3/3 is real, but Scenario 2b changes what it's
  evidence of.** The gap was a skill-discovery failure (the `Skill` tool
  never fired), not a skill-compliance failure — confirmed, not inferred,
  by forcing discovery in Scenario 2b and watching compliance return to
  3/3. This report keeps Scenario 2's original framing on the record and
  corrects it here rather than quietly rewriting it, because a comparison
  that only survives by not testing its own explanation isn't one worth
  citing at HN. None of the three scenarios is cherry-picked after the
  fact: 1 ran first, its own "Known limitations" section named "smaller/
  cheaper model" as the expected-to-widen-the-gap follow-up before 2
  existed, and 2's own transcripts (0 `Skill` invocations) are what
  prompted 2b.
- **This is not a statistical study.** N=3 per arm per scenario is worked
  mechanism evidence with real, checkable transcripts, not a
  compliance-rate estimate for any model in general. Don't read "0/3" or
  "3/3" above as a population rate — read it as "in these real invocations,
  this specific thing happened, here's the transcript."
- **The actual, surviving claim is about discovery, not compliance, and
  about *kind* of guarantee, not *rate*.** Across all three scenarios, once
  an agent genuinely reads a rule — via a real skill or a flow's own agent
  step — it tends to follow it. The difference is what stands between "the
  rule exists" and "the rule was applied": for a skill, it's the agent (or
  a human writing the prompt) correctly deciding to go check, which failed
  silently in Scenario 2 and required a deliberate, hand-written nudge to
  fix in 2b. For a relayflow gate, nothing stands there — the check just
  runs, and a run cannot report success while it's failing, independent of
  whether anything "decided" to look. Scenario 2's flow runs needed the
  retry 3/3 times for the identical reason the bare agent failed, and
  fixed it anyway, without anyone writing a nudge for this specific task.

## Reproduce it

```sh
cd examples/skill-vs-flow-compliance

# Scenario 1 (trivial task, default/frontier model):

# Arm A: agent + skill (installed fresh into an isolated git repo per trial)
node --experimental-strip-types shims/run-agent-trial.ts --trial 4

# Arm A-control: same, no skill installed
node --experimental-strip-types shims/run-agent-trial.ts --trial 4 --no-skill

# Arm B: the relayflow (bare task, gate + bounded retry, no skill involved)
node --experimental-strip-types shims/run-flow.ts --run 4

# Scenario 2 (harder task, cheaper model) — same three commands, plus:
node --experimental-strip-types shims/run-agent-trial.ts --trial 4 --task TASK-HARD.md --model haiku --scenario hard
node --experimental-strip-types shims/run-agent-trial.ts --trial 4 --no-skill --task TASK-HARD.md --model haiku --scenario hard
node --experimental-strip-types shims/run-flow.ts --run 4 --task TASK-HARD.md --model haiku --scenario hard

# Scenario 2b (Scenario 2's agent+skill arm, discovery forced):
node --experimental-strip-types shims/run-agent-trial.ts --trial 4 --task TASK-HARD.md --model haiku --scenario hard-nudged --nudge-skill
```

Requires an authenticated `claude` CLI on `PATH` (`claude auth status`), and
that the host resolves `--model haiku` (`claude -p --model haiku ...`) for
Scenario 2. Each invocation makes one or two real, billed model calls and
writes fresh evidence under `runs/<arm[-scenario]>/`; nothing here is mocked
or replayed. Trial/run numbers are not reused per arm — pick a fresh
`--trial`/`--run` value or a prior directory is left in place rather than
silently overwritten.

Typecheck (opt-in, mirrors `examples/research`):

```sh
npm --prefix examples/skill-vs-flow-compliance run typecheck
```

## Files

```
examples/skill-vs-flow-compliance/
  TASK.md                 Scenario 1's bare task, identical across every arm
  TASK-HARD.md             Scenario 2's bare task (four independent changes, one pass)
  SKILL.md                 the four house conventions, as a skill — unchanged across scenarios
  fixture/                 the task repo template, copied fresh per trial/run
  checks/*.sh              the four rules as deterministic scripts — the shared ground truth
  compliance-flow.ts       arm B: the relayflow (v2 dialect, docs/SURFACE.md)
  shims/
    trial-runtime.ts       shared plumbing: materialize an isolated repo, run checks
    run-agent-trial.ts     arm A + arm A-control entry point (--task/--model/--scenario select the scenario)
    run-flow.ts            arm B entry point — implements postfix .gate() in
                            userland, same documented gap as examples/research/shims/run.ts
  runs/                    captured evidence, one dir per arm per scenario
    agent-plus-skill/, agent-no-skill/, relayflow/            Scenario 1 (default model)
    agent-plus-skill-hard/, agent-no-skill-hard/, relayflow-hard/   Scenario 2 (--model haiku, TASK-HARD.md)
    agent-plus-skill-hard-nudged/                             Scenario 2b (Scenario 2 + --nudge-skill)
                             (gitignored: runs/**/repo/, the live git repos)
```

## Known limitations

- **Single CLI (Claude).** Unlike `examples/research`'s three-lane fan-out,
  this example doesn't vary the CLI — the question here is skill-vs-gate,
  not CLI-vs-CLI. Two models are covered (Opus-tier default in Scenario 1,
  Haiku in Scenario 2), which is what surfaced Scenario 2's gap; a third
  provider's model is a natural further follow-up, not attempted here.
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
- **Scenarios 2 and 2b are still N=3 per arm, one task, one cheap-tier
  model.** They answer "does a discovery gap show up, and does forcing
  discovery close it" (yes to both, verified) not "how often does an
  unprompted model discover a given skill in general" (not attempted, and
  would need far more trials across more tasks, models, and numbers of
  installed skills to say honestly — discovery presumably gets harder, not
  easier, the more skills compete for the same decision).
- **The discovery nudge in Scenario 2b is generic, not this skill's
  content.** It doesn't name `engineering-conventions` or paste any of its
  four rules, so 2b is still measuring compliance-once-discovered rather
  than compliance-with-the-rules-restated. But it's still a hand-written
  addition to the prompt, chosen by us, after seeing Scenario 2 fail — in a
  real workflow, writing that nudge into every task for every relevant
  skill in advance is exactly the "usually a human remembers" dependency
  this comparison is about.
