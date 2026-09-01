# hn-monitor-real-cli: Wire the analyze-story step to a real LLM

The `testdata/hn-monitor.flow.yaml` `analyze-story` step currently
runs against deterministic stub CLIs (PR #124 landed the plumbing,
PR #125 landed wake-context env-var wiring). What's missing:
`analyze-story` never actually invokes an LLM to analyze the story.
This task wires a real Claude invocation.

## What ships

- `testdata/preflight/analyze-story-claude-cli` — new executable
  script (Node or shell) that:
  1. Reads `$RELAYFLOW_WAKE_CONTEXT` and extracts the story ID
     from `.triggering_event.payload.id`.
  2. Optionally fetches the story metadata from
     `https://hacker-news.firebaseio.com/v0/item/<id>.json` (if
     network is available — the script should degrade gracefully
     when it isn't, still emitting valid schema-matching JSON).
  3. Invokes `claude -p --dangerously-skip-permissions` with a
     prompt that includes the story context and asks for JSON
     matching the `analyze-story` schema
     (`story_title`/`relevance_score`/`reasoning`).
  4. Emits the parsed LLM output as a single JSON object to stdout.
  5. Exits 0 on valid JSON emission, non-zero otherwise.

- New integration test in `sdk/tests/live-kernel.test.ts`
  (`hn-monitor analyze-story runs a real Claude analyzer against
  the triggering event`) that submits an hn-story event, waits for
  the step to reach `done`, and asserts the promoted output
  matches the schema. This test SKIPS itself with a visible
  warning if either `claude` is missing on PATH or
  `ANTHROPIC_API_KEY` (or equivalent) isn't set — following the
  "no silent skips" rule from PR #125's M lens.

## Non-goals

- Adding retry logic for network failures — the stub falls back to
  a "cannot fetch" analysis when firebase is unreachable.
- Wiring `hn-monitor.flow.yaml` (the canonical spec) to
  hard-code the new CLI. The spec author picks the CLI; this task
  ships the OPTION, not the default. The integration test patches
  the spec in-memory.

## Rules

Follow ops/factory/brief-template.md's rules: branch off main, one
truthful commit, pre-swarm-check MUST pass before push, do not
touch `ops/factory/**`, exit with `FACTORY_RESULT:` line.
