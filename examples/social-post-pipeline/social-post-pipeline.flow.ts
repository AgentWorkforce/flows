// social-post-pipeline — a v2 relayflow (docs/SURFACE.md dialect).
//
// The "generate a social post" use case: a small swarm of agents that
// research a topic, draft a post, fact-check it against the research (not
// against its own opinion), and design a graphic — then a human decides
// whether it actually goes out. No agent in this flow is trusted to publish
// on its own word; the fact-checker's gate reads a file it wrote, not a
// substring of what it said — the same lesson examples/research/README.md
// documents: "substring gates on model output are fail-open."
//
// STATUS: runs. `f.agent` needs a worker (`flows run --local-agent`, or
// Cloud), and `f.human` parks the run durably on the kernel's `wait.human`:
// `flows run` exits 3 naming the question, `flows answer <run> human-N yes|no`
// records the decision, and `flows resume` continues from the same line with
// it. See README.md.

import { flow } from "@relayflows/surface";

export interface SocialPostInput {
  brand: string;
  topic: string;
  /** Who approves before it publishes, e.g. a Slack handle. */
  approver: string;
}

export default flow<SocialPostInput>(
  "social-post-pipeline",
  { budget: "$5/run" },
  async (f, input) => {
    const research = await f
      .agent("researcher", {
        task:
          `Research current, verifiable facts about "${input.topic}" for ` +
          `${input.brand}. Cite a source for every claim. Write your findings ` +
          `to research/notes.md.`,
        workspace: "research/: readwrite",
      })
      .gate(
        (r) => r.artifacts.includes("research/notes.md"),
        "the researcher must write research/notes.md, not just summarize in chat",
      );

    const draft = await f
      .agent("writer", {
        task:
          `Read research/notes.md and draft one social post for ${input.brand} ` +
          `about "${input.topic}". Do not state anything the research does not ` +
          `support. Write the draft to drafts/post.md.`,
        workspace: "drafts/: readwrite",
      })
      .gate(
        (r) => r.artifacts.includes("drafts/post.md"),
        "the writer must write drafts/post.md",
      );

    // The fact-checker's only job is to distrust the writer. It gates on a
    // file it wrote, never on parsing its own prose: an agent that "says"
    // PASSED without writing the marker fails closed.
    const factCheck = await f
      .agent("fact-checker", {
        task:
          `Check every factual claim in drafts/post.md against research/notes.md. ` +
          `If — and only if — every claim is directly supported, write ` +
          `drafts/fact-check.passed containing the word PASSED. Otherwise write ` +
          `drafts/fact-check.rejected explaining exactly which claim is unsupported.`,
        workspace: "drafts/: readwrite",
      })
      .gate(
        (r) => r.artifacts.includes("drafts/fact-check.passed"),
        "the post must pass fact-check before a graphic is even worth making",
      );

    const graphic = await f
      .agent("designer", {
        task:
          `Read drafts/post.md and generate one on-brand graphic for ${input.brand} ` +
          `to accompany it. Write it to drafts/graphic.png.`,
        workspace: "drafts/: readwrite",
      })
      .gate(
        (r) => r.artifacts.includes("drafts/graphic.png"),
        "the designer must actually produce drafts/graphic.png",
      );

    const approved = await f.human(
      `Ready to publish for ${input.brand}:\n\n${draft.summary}\n\n` +
        `Fact-check: ${factCheck.summary}\nGraphic: drafts/graphic.png\n\nPublish?`,
      { to: input.approver },
    );
    // A "no" is a decision the flow made, not a kernel cancellation.
    if (!approved) return f.done("declined");

    f.done("success");
  },
);
