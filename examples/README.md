# examples — relayflows authored on the v2 surface

Each example is a self-contained unit: the flow in the v2 dialect
(`docs/SURFACE.md`), pure helpers, `shims/` that execute it on today's runtime
with `REPLACE-WHEN: gate-N` headers, tests, and a README. Examples are the
consumers that tell gate-1 SDK work what `@relayflows/surface` must export.

| Example | What it shows |
|---|---|
| [`research/`](research/) | Fan-out to three model lanes (Claude, Codex, Grok), two subagents each, one synthesis; postfix gates on the workspace; dynamic input. First real run: `research/runs/2026-09-02-agent-memory/`. |
| [`social-post-pipeline/`](social-post-pipeline/) | Research → draft → adversarial fact-check → graphic, gated on a human approval before anything publishes. Written directly against the real `@relayflows/surface` package. |
| [`pr-review-pipeline/`](pr-review-pipeline/) | Security/correctness/performance reviewer agents fan out in parallel, gated on writing their findings, then a consensus agent reconciles disagreement between them. |
| [`dependency-upgrade-bot/`](dependency-upgrade-bot/) | A deterministic check flags an outdated dependency; one agent upgrades it in a sandbox, a second, independent agent verifies the whole app with computer use in a separate sandbox before a PR opens. |

The last three are written directly against the real `@relayflows/surface`
package (`npm --prefix packages/surface run typecheck:examples`) rather than
against local shims — they typecheck today but don't run yet; each one's
README says exactly what's real and what gate work it's waiting on.
