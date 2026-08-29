Harden the Garden's loop with a case it does not yet handle. CODE task, SDK-side.

On main now, all merged and tested:
  - `sdk/src/backlog-picker.ts` — proposes a work package from ops/BACKLOG.md
  - `sdk/src/work-package-consumer.ts` — judges one, refusing with a typed
    reason (missing_title / missing_scope / missing_definition_of_done)
  - `testdata/backlog-picker.flow.yaml` — the flow, with its canonical spec
  - a test running the flow's real emit-package output through the consumer,
    proving the two halves interoperate in both directions

So propose -> judge -> accept/refuse works end to end. What it does NOT do is
survive a hostile or malformed backlog. Pick ONE of these and do it properly:

  (a) The picker reads whatever ops/BACKLOG.md contains. A malformed entry — a
      bold title with no body, an unterminated backtick, a bullet nested under
      another — should produce a typed refusal, never a crash and never a
      half-formed package. Add the handling and the tests.

  (b) The consumer accepts any package whose fields are present. It does not
      check that files_in_scope names paths that EXIST, so a package can be
      accepted while scoping files that are not there. Add that check as a new
      typed refusal reason, with tests.

Definition of done, all of it:
  - code in sdk/src, wired into sdk/src/index.ts if it is a new export
  - tests covering the new behaviour AND the existing behaviour still passing
  - `cd sdk && npm test` green
  - EVERY new test confirmed to FAIL against current code, with the literal
    failing output quoted in your summary
  - as your LAST action, run `git status --porcelain` and paste it

Do NOT touch kernel/, sdk/src/demo-hn-monitor.ts, or anything under ops/.
ONE cycle, about ten minutes. Small and true beats large and aspirational.
