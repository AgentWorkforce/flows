# prompt-lab

The Prompt Lab product brief as one relayflow. Prompt Lab is the workbench for
writing and fixing the prompts that draft home-health charts. The brief defines
two jobs and a shelf of fake patients. This flow covers all three:

| `job` | Brief section | What it does |
| --- | --- | --- |
| `new-agency` | Job 1 · Config-level / new agency | Sorts the agency's questions into sharing piles, writes first-pass prompts for agency-specific questions, runs them on shelf patients, and puts the output in an edit grid. Your first pass is saved as targets. Iteration runs on changed rows. Agency-specific prompts are committed (all / only / all except). Shared rows go to the question manager. |
| `fix` | Job 2 · Question-level refinement | Takes one question, from an issue or picked directly. Runs it on shelf patients, and your review of the grid is saved as gold. The iterator rewrites the prompt, Prompt QA checks it, and it re-runs and scores against gold (% worked, per patient). Marking it done makes it live. |
| `patient` | Set up test patient | Takes a gap brief from the manager queue. An agent writes a patient plan and you kick generate. Patient QA loops until it passes, then locks the patient onto the shelf. |

Each job file is its brief diagram, line by line:

- **System** boxes are either deterministic TypeScript over journaled reads, or model calls.
- **You** boxes are `f.human` gates, asked of `input.reviewer`.
- **Outcome** boxes are writes to the lab store.

## What maps to what

| Brief | Here |
| --- | --- |
| Apricot's Bank (`livePromptId`, global prompts) | `bank.json` in the lab directory, written only by [`store.ts`](store.ts) |
| The chart-filling engine nurses use | an `llm` step given the live prompt and the patient. Its answer must be on the agency's menu (the schema's `enum`) |
| Sharing piles: a deterministic lookup, never an agent | [`lib/piles.ts`](lib/piles.ts) |
| Computer-highlighted rows | [`lib/grid.ts`](lib/grid.ts) `highlights`: confidence below High, a mismatch pile, or a never-reviewed first-pass prompt |
| First pass persists as targets / gold | `store.ts record`, fed only from the grid you reviewed. AI output never writes gold directly |
| Iterator: rewrite-only | [`prompts.ts`](prompts.ts) `iterate`. Input is the changeset, patients, brief and existing prompt; output is new prompt text |
| Prompt QA: the brief plus shared guidelines | `promptQa`, looping with the iterator. Capped at 3 tries, then the run parks as `needs_human` |
| Done = live | `store.ts publish` sets `livePromptId`. There is no promote step. A shared question warns which agencies it will change, and the re-run scores the new prompt on **every distinct menu** it is asked with ([`lib/piles.ts`](lib/piles.ts) `distinctMenus`), because done changes it for all of them |
| Shared frozen at config level | a changed shared or mismatch row becomes a `config-send` issue that carries its targets and a proposed rewrite |
| Test planner: never invents a patient | picks shelf patients of the run's visit type (checked deterministically); each hole becomes one gap brief per question × visit type |
| You do not approve the chart | the only patient gate is *kick generate*. Patient QA, plus a deterministic identifier check ([`lib/phi.ts`](lib/phi.ts)), locks it |

Every read and write of the lab is a journaled `f.run` step. Every store verb
is idempotent, so a retried step lands the lab in the same state. `write-new`
never overwrites an edit you made. Mutating verbs take an exclusive lab lock,
so two runs at once never lose each other's update.

A first-pass prompt is offered for commit only after it has run on a shelf
patient and you have reviewed its rows. A prompt whose question is a gap waits
as a draft until a patient covers it.

**Not built:** anything the brief lists under "Not at the start". Also not
built:

- Drafting a question brief with an agent. The flow reads a brief when one
  exists in `briefs/<questionId>.md`.
- The Apricot patient-brief generator. It runs on live patients, so it belongs
  in Apricot.
- The UI screens.

The flow is the job graph that sits under those screens.

## Run it

```sh
npm install
npm test                                    # 20 unit tests over the deterministic parts and the store
node --experimental-strip-types store.ts ./my-lab seed fixtures
npx flows run prompt-lab.flow.ts --local-agent --input \
  '{"job":"new-agency","reviewer":"<who answers the gates>","lab":"./my-lab","agency":"sunrise","visitType":"soc"}'
```

`reviewer` and `lab` are required, and there is no default person. The run
parks at each gate and prints the file to edit plus the `flows answer` /
`flows resume` commands. Edit the file, answer `yes`, resume. Answering `no`
stops the job as `declined` and keeps what was saved.

The fixtures are invented and reproduce the brief's own examples. The new
agency `sunrise` asks four questions:

- **wound-status**: shared with harbor and maple, with an identical menu.
- **mood**: a shared prompt, but sunrise adds "Agitated" to the menu, so it's a mismatch.
- **living-situation**: agency-specific, with no prompt yet.
- **ostomy-supplies**: agency-specific, with no shelf patient.

The shelf holds Pat, Jordan and Riley. The shared wound prompt contains a
deliberate flaw: it lets the referral overrule today's visit notes.

## Proof

[`prove.sh`](prove.sh) seeds a fresh lab and drives all three jobs through the
real kernel with real Claude calls (`--local-agent`). At each gate it acts as
the reviewer and applies the edit described in its comments, captured as a
diff. It captures every command with its output and exit code in
[`evidence/run/`](evidence/run/), and the final lab lands in
`evidence/run/lab/`.

```sh
./prove.sh evidence/run
```

The captured run (Claude Code 2.1.280, the adapter's default model). `prove.sh`
stops on the first exit it didn't expect, so reaching the final state means
every step below exited as shown:

| Run | Result | What happened |
| --- | --- | --- |
| Job 1 · `sunrise` / `soc` ([01](evidence/run/01-job1-run.txt), [04](evidence/run/04-resume.txt), [06](evidence/run/06-resume.txt)) | 29 steps, `success` | Piles came out as shared / mismatch / agency-specific. Both agency-specific questions got first-pass prompts that passed Prompt QA. The planner covered 3 questions from the `soc` shelf and queued `gap-ostomy-supplies-soc`. Gate 1: 9 rows, 7 highlighted. The reviewer raised Pat's wound confidence to High, rewrote the explanation and added a note ([02](evidence/run/02-reviewer-edit.diff)). That shared row went to the question manager with its target. Gate 2 offered only `living-situation`, and it went live. `ostomy-supplies` had no shelf patient, so it was held as a draft. |
| Patient · `gap-ostomy-supplies-soc` ([07](evidence/run/07-patient-run.txt), [09](evidence/run/09-resume.txt)) | 9 steps, `success` | Plan, then kick generate. The chart passed Patient QA on its first try, and `verna` locked onto the shelf. The brief is marked `locked`. |
| Job 2 · the config-send issue ([10](evidence/run/10-job2-run.txt), [12](evidence/run/12-resume.txt), [14](evidence/run/14-resume.txt)) | 22 steps, `success` | Three shelf patients. Gold came prefilled, with Pat's config target carried over. The iterator's rewrite passed Prompt QA. The re-run scored 3 of 3 golded patients worked (100%), and the gate warned it would change harbor, maple and sunrise. Done made the new prompt live and closed the issue. |

Final state: [15-lab-state.txt](evidence/run/15-lab-state.txt), with the whole lab in `evidence/run/lab/`.

**What this run does not show:**

- **A wrong answer being fixed.** The model answered Pat "Ongoing / Medium"
  even under the flawed wound prompt. So Job 2 iterated on confidence, the
  explanation and source priority, not on the answer.
- **Re-running on several menus.** `wound-status` has one menu across its
  agencies, so the per-menu re-run ran with one. The multi-menu case, a
  mismatch question like `mood`, is covered by the `distinctMenus` unit test
  only.
- **A clinician's judgment.** The reviewer at every gate is `prove.sh`,
  applying fixed edits.

The brief's exact failure, "Healed / High" for Pat, did occur in an earlier
`claude-sonnet-5` run of the same prompt. Its engine step's journal is in
[00-sonnet-run-pat-healed-high.txt](evidence/runtime-findings/00-sonnet-run-pat-healed-high.txt).

## Runtime findings (relayflows 2.0.29)

Four things in the runtime shaped this flow or its proof. Each workaround is commented
where it lives, and each has captured evidence in
[`evidence/runtime-findings/`](evidence/runtime-findings/):

1. **More than a few concurrent `f.llm` calls lose the run.** The queued
   calls' 30 s leases expire before the worker takes them. The late completion
   of a dead attempt is then refused ("Agent lease is already expired"), and
   the CLI turns that refusal into a fatal `protocol_error`. Five parallel
   calls passed and nine failed, with `--agent-capacity` 4 or 1.
   [`runtime-parallel-llm-repro.flow.ts`](evidence/runtime-findings/runtime-parallel-llm-repro.flow.ts)
   reproduces it with no Prompt Lab code. **Workaround:** model calls run
   sequentially. Tracked in [#561](https://github.com/AgentWorkforce/flows/issues/561) and [#560](https://github.com/AgentWorkforce/flows/issues/560).
2. **A predicate `.gate(fn)` before an `f.human` can't be resumed.** The
   verdict is read back from the `predicate-gates` stream with its keys
   re-ordered. The lowered `<step>.gate` command no longer matches, and the
   resume is refused as `run_admission_conflict`. The fix is one line in
   `packages/sdk/src/authored-flow-executor.ts` `applyPredicateGate`: build the
   literal from fixed fields, not from `JSON.stringify(record)`.
   **Workaround:** the checks run in the body and fail through a journaled
   failing step (`failStep`). **Fixed in [#558](https://github.com/AgentWorkforce/flows/pull/558).**
3. **`f.llm(prompt, { output })` fails when the reply is fenced JSON.** The
   worker validates the raw reply. Sonnet sometimes wraps valid JSON in
   ```` ```json ```` anyway, and a failed run can't be resumed.
   **Workaround:** text-form `f.llm`, then
   [`lib/reply.ts`](lib/reply.ts) strips one fence and validates the schema,
   with one bounded re-ask. The text form takes no `model`, so calls use the
   Claude adapter's default model. **Fixed in [#558](https://github.com/AgentWorkforce/flows/pull/558).**

4. **A lease renewal that races a completion kills the run.** A step whose
   child run journaled `success` was reported as
   `lease_conflict: attempt has no active worker lease`. The CLI made that a
   fatal `protocol_error`
   ([00-prove-attempt1-lease-conflict-after-success.txt](evidence/runtime-findings/00-prove-attempt1-lease-conflict-after-success.txt)).
   It's intermittent: it happened once in about 50 sequential calls. There's
   no workaround in the flow, so rerun. Tracked in [#560](https://github.com/AgentWorkforce/flows/issues/560).

Findings 1 and 4 are the same class of problem: late lease traffic becomes
fatal to the whole run instead of being ignored.

Local only for now: Cloud receives a single authored source, and this flow
imports sibling modules.
