Close the gap between the Garden's two halves. CODE task, SDK-side.

On main: `sdk/src/backlog-picker.ts` proposes a work package from
ops/BACKLOG.md (four tested properties).

NOT on main: the consumer that judges a package. It exists in open PR #23
(`sdk/src/work-package-consumer.ts`, seven tests) and has not been merged. An
earlier version of this brief claimed it was on main; a run took that at face
value, found only one half of the pair, and correctly escalated rather than
inventing the other. It was right and the brief was wrong.

Build the consumer's counterpart that CAN be built against main today: a
validator for what the picker emits, living beside the picker, that returns
either an accepted package or a typed refusal naming what is missing (no title,
empty scope, no definition of done). Do not import from PR #23 — it is not
merged, and a run must build against main, not against an open branch.

That is the Garden's smallest complete loop — propose, judge, accept-or-refuse
— and nothing exercises it end to end today.

Definition of done, all of it:
  - a new exported function in sdk/src, wired into sdk/src/index.ts
  - tests covering: a backlog that yields an acceptable package; a backlog that
    yields one the consumer refuses; and an empty backlog
  - `cd sdk && npm test` green
  - EVERY new test confirmed to FAIL against current code, with the literal
    failing output quoted in your summary
  - as your LAST action, run `git status --porcelain` and paste it

Do NOT touch kernel/, sdk/src/demo-hn-monitor.ts, or anything under ops/.
ONE cycle, about ten minutes. Small and true beats large and aspirational.
