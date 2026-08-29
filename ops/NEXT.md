# NEXT — WP-32: Sharpen backlog picker's actionability selection

This run is pinned to **gate 3** per ops/TARGET.md.

## Objective

Fix `validateWorkPackage` / `packageFromEntry` in `sdk/src/backlog-picker.ts` so `select-entry` selects a real engineering task from the current ops/BACKLOG.md and does NOT select the "Upstream issues" notes entry.

## Root cause (quoted from TARGET.md)

> Run `select-entry` against the real ops/BACKLOG.md. It prints:
>
>     SKIPPED_UNACTIONABLE=10 ...
>
> and then selects a dated notes blob ("Upstream issues (2026-08-27):") as the
> work package. Ten genuine engineering tasks were skipped in favour of a list of
> links.
>
> The cause: `validateWorkPackage` decides "actionable" using only two shallow
> signals — does the text contain a backticked path, and does it contain a
> multi-word backticked phrase. A notes blob full of backticked identifiers
> passes both. A real task written in prose ("Refuse a path-like deterministic
> command word when that path does not exist") fails both.
>
> The guard is correct. The SELECTION is poor. That is what to fix.

## Files in scope

- `sdk/src/backlog-picker.ts` — sharpen the notion of actionability
- `sdk/src/index.ts` — wire new exports if any
- `testdata/backlog-picker.flow.yaml` — only if changes required
- `testdata/backlog-picker.spec.canonical.json` — MUST regenerate if yaml changes
- Tests covering the new behavior

## Definition of done (all of it, from TARGET.md)

1. A sharper notion of actionability in `sdk/src/backlog-picker.ts`, wired into sdk/src/index.ts if it is a new export
2. It must SELECT a real engineering task from the current ops/BACKLOG.md and must NOT select the "Upstream issues" notes entry. **Quote the literal before/after `select-entry` output** — the actual title it picked before your change and after it.
3. Tests covering the new behavior AND every existing test still passing
4. `cd sdk && npm test` green
5. `cd kernel && sh ../ops/cargo.sh test` green
6. If you touch testdata/backlog-picker.flow.yaml you MUST regenerate testdata/backlog-picker.spec.canonical.json — the kernel consumes the canonical spec, not the yaml, and a drift test will fail you
7. **EVERY new test confirmed to FAIL against current code**, with the literal failing output quoted in your summary
8. As your LAST action, run `git status --porcelain` and paste it

## Explicitly OUT of scope

- Re-implementing `nonexistent_files` check (already done and merged in PR #28)
- Re-implementing malformed-backlog handling (already done and merged in PR #30)
- Work on any gate other than gate 3
- Any work not directly required to fix the selection rule

## Success criteria

The `select-entry` step against the real ops/BACKLOG.md must:
- Skip the "Upstream issues" notes blob
- Select a genuine engineering task instead
- The before/after command output must be quoted literally in the final summary
