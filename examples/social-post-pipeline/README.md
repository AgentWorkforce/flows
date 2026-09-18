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

## Running it

```sh
flows run --local-agent social-post-pipeline.flow.ts \
  --input '{"brand":"acme","topic":"launch week","approver":"khaliq"}'
# … agents run; the flow reaches f.human and parks:
# PARKED [run_parked] Run "<run-id>" is waiting for khaliq to answer human-5: "Ready to publish …"
# Answer with: flows answer <run-id> human-5 yes|no
flows answer <run-id> human-5 yes --note "copy approved"
flows resume --local-agent <run-id>
```

`f.human` parks the run on the kernel's durable `wait.human` (exit 3, the same
park code as every other wait). The question, who it is for, the answer, who
gave it and when are all journal facts; the resumed body re-runs to the same
line, finds the recorded answer, and every agent step before it is memoized —
nothing upstream is repeated. A `no` is a flow decision (`done("declined")`,
exit 0), not a failure. On Cloud the same wait is answered through the run's
answer route instead of the CLI.

`f.agent(...)` needs a worker: `--local-agent` locally, or run it on Cloud.
