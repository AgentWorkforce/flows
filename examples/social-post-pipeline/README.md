# social-post-pipeline

**Like I'm 5:** A brand wants a social media post. One robot researches the
topic and writes down facts with sources. Another robot writes the post
using only those facts. A third robot's *only* job is to catch the writer
lying — it checks every claim against the research and refuses to say
"PASSED" unless every single one holds up. A fourth robot makes the picture
to go with it. Then a person looks at everything and decides yes or no
before it actually goes out. No robot gets to hit publish by itself.

## The shape

```
research (agent) → write draft (agent) → fact-check (agent, gated) → make graphic (agent) → human approval → done
```

`social-post-pipeline.flow.ts` is written against the real
`@relayflows/surface` package (`docs/SURFACE.md` dialect). The interesting
part isn't the agents — it's what each `.gate()` checks:

- Every gate reads a **file the agent wrote** (`research/notes.md`,
  `drafts/post.md`, `drafts/fact-check.passed`, `drafts/graphic.png`), never
  a substring of what the agent said. `examples/research/README.md` already
  documents why: *"substring gates on model output are fail-open"* — an
  agent that talks about doing the work isn't the same as an agent that did
  it.
- The fact-checker is deliberately adversarial to the writer, the same
  pattern `customer-agents/native`'s real "Autopilot" flow uses in
  production: a second agent whose whole job is to distrust the first one,
  gated on a file, so a hallucinated claim can't slip through just because
  it reads smoothly.
- The human gate (`f.human`) is the last word. Everything upstream can pass
  every gate and the flow still won't publish without a yes.

## Status: typechecks, does not run yet

```sh
cd packages/surface && npm run typecheck:examples
```

- `f.agent(...)` builds a real step, but parks without a worker attached —
  same as every other example in this repo today.
- `f.human(...)` currently **throws** `unsupported_verb` in the SDK's
  authored-flow executor (`packages/sdk/src/authored-flow-executor.ts`). The
  human-approval gate is declared surface, not yet wired to any execution
  path — it's sequenced behind gates 2-4 and the `f.human` channel-delivery
  work tracked for gate 6 (`ops/BACKLOG.md`).

This flow documents the intended shape so that when `f.human` and the agent
worker land, this example starts working with no rewrite — just like
`docs/SURFACE.md` §1 promises: *"a simple flow becomes a harness by
accretion, never a rewrite."*
