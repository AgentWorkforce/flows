# examples — relayflows authored on the v2 surface

Each example is a self-contained unit: the flow in the v2 dialect
(`docs/SURFACE.md`), pure helpers, `shims/` that execute it on today's runtime
with `REPLACE-WHEN: gate-N` headers, tests, and a README. Examples are the
consumers that tell gate-1 SDK work what `@relayflows/surface` must export.

| Example | What it shows |
|---|---|
| [`research/`](research/) | Fan-out to three model lanes (Claude, Codex, Grok), two subagents each, one synthesis; postfix gates on the workspace; dynamic input. First real run: `research/runs/2026-09-02-agent-memory/`. |
