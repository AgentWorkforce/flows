# Name the missing worker in every park, and stop `resume --local-agent` from being ignored

## Summary

A run that parks for want of an agent worker now names the invocation that
supplies one — on every path that can park, not just `flows run` against a spec
file. And `flows resume --local-agent`, which the usage line has always
advertised, is now either honoured or refused; it is never accepted and ignored.

Two defects, one cause: the remedy was a string literal welded into
`classifyOutcome`, guarded by `command === 'run' && !isAuthoredFlowPath(path)`.

- An authored `.flow.ts` got **nothing**. The omission was deliberate — the bare
  `flows run --local-agent '<path>'` would be refused for want of `--input` —
  but the result read as "your infrastructure is missing a worker" when the fix
  was one flag away.
- A parked `flows resume` got **nothing**, because of the `command` guard.
- Anyone who had *already* passed `--local-agent` got told to pass it again, or
  got silence. Neither is the truth, which is that a worker was offered and none
  of them was eligible for the step.

## What changed

**The remedy became a value.** `src/cli/local-agent-remedy.ts` holds a closed
union — `none | attached | spec-run | spec-resume | authored-run` — and one
formatter. A park decides *which* remedy it has; only the formatter decides how
it reads. Both authored boundaries share one decision function,
`authoredWorkerRemedy`, so `flows run` on a `.flow.ts` and `flows resume` on the
same root cannot disagree.

| Parked | Now prints |
|---|---|
| `flows run <spec>` | `flows run --local-agent '<path>'` — **byte-identical prefix to before**, plus the `--data-dir` this invocation used |
| `flows resume <run-id>` on a spec run | `flows resume --data-dir <dir> --local-agent <run-id>` — *this* run, which is resumable |
| An authored `.flow.ts` | `flows run --local-agent '<path>' --input '<input>'`, repeating the input the parked run was started with |
| …with `--local-agent` already passed | "no attached worker was eligible for this step" — and no command |
| A `needs_human` recovery wait | nothing about workers, on any path |

Where the journal recorded no input, the authored case states the requirement in
prose rather than emitting `--input '{}'`: a fabricated input names a different
invocation of the flow than the one that parked.

**The cause travels as a value, not as wording.** `agent_parked` covers both "nothing
is attached" and the kernel's `needs_human` recovery wait, and only the first is
fixed by a worker. A new `ParkCause` (`src/failure-kinds.ts`, beside the rest of
the run vocabulary) is set by `classifyOutcome`, carried on `RunReport.parkCause`
and `AuthoredFlowExecutionError.parkCause`, forwarded across the Bun→Node IPC
error frame, and **validated** on the way back in (`parkCauseFrame`, fail closed
to `undefined`). An unclassified park gets no guess.

**`flows resume --local-agent` now means something.**

- *Declarative runs*: honoured. It attaches a worker and drives the parked step.
  That code existed; nothing had ever exercised it end to end, which is how the
  field report lost a cycle.
- *Authored roots*: refused, because `--local-agent` is admitted at run start and
  pinned into the root's metadata — a resume can only reproduce the surface the
  run began with. The two guards that already knew this threw bare `Error`s and
  surfaced as `protocol_error` / `RUN <id> unknown`, blaming the daemon for an
  invocation mistake. They are now exit-2 `REFUSED [local_agent_unavailable]`,
  returned *before* any worker attaches and before the resume touches the
  journal, each naming the opposite remedy: start a new run, or resume with the
  flag you dropped.

**Also fixed on the way through.** An authored resume that parked for want of a
worker fell through to `protocolFailure`; it is now the exit-3 park it is, with
the child run holding the evidence and the root it was resumed from kept
separate (`runId` / `rootRunId`).

## Acceptance

Both criteria from the report are asserted against the built CLI and a real
`relayflowd`, not against mocks.

- *"Parking a `.flow.ts` run at an agent step prints a runnable remedy."*
  `tests/local-agent-live.test.ts` parks a real authored flow started with
  `--input '{"task":"it'"'"'s a plan","n":1}'`, then feeds the printed line back
  through `sh -c` **verbatim** and asserts the flow completes and the agent
  wrapper really ran. Runnable is proven by running it, so the quoting, the flag
  order and the argument values are all covered at once.
- *"A test asserts it never parks with the identical message twice."*
  `tests/yaml-local-agent-live.test.ts` parks a spec run, resumes it with
  `--local-agent`, and asserts exit 0 / `completionReason: success` — and that
  the first park's message does not reappear. A companion test takes the case
  where the flag genuinely cannot help (a declared workspace surface no local
  worker holds) and asserts the second message *differs* and says a worker was
  attached but ineligible.

## Tests

New: `tests/local-agent-remedy.test.ts` (11) — every remedy shape, with a real
`sh -c` round-trip of each rendered command and a hostile input
(`{"shell":"$(rm -rf /)"}`) and path (`my flows/a b's.flow.ts`).
`tests/resume-local-agent.test.ts` (7) — both refusals, proven to attach nothing
and journal nothing, proven not to be `protocol_error`, plus the authored resume
park.

Extended: `classify-outcome` (+4, including the authored-suppression ordering
that would otherwise double the clause), `direct-run-failure` (+4),
`yaml-local-agent-live` (+2), `local-agent-live` (+1).

`npm run typecheck` clean. Full `packages/sdk` suite: **2382 passed, 40 failed** —
the same 40, test for test, on a clean `git stash` of this branch's HEAD. They
are environmental: `kernel/target/debug/relayflowd` does not exist in this
sandbox (the live suites that resolve it via `ops/cargo.sh` all pass), and
`stuck-run-triage.test.ts` fails on an unrelated surface-handle assertion.

## Docs

`docs/SURFACE.md` §5 gains *Naming the worker a park is missing* — the remedy
table, the two parks that deliberately print nothing, and the run-start admission
rule that makes the authored resume a refusal. The exit-`2` row now lists
`local_agent_unavailable`.

## Not in scope

Whether `--local-agent` should be the default, and the empty observer URL on
`--local-agent` runs (#341).
