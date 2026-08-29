Close the gap between the Garden's two halves. CODE task, SDK-side.

On main already: `sdk/src/backlog-picker.ts` proposes a work package from
ops/BACKLOG.md (four tested properties), and `sdk/src/work-package-consumer.ts`
validates one and refuses it with a typed reason when it lacks a title, scope,
or definition of done (seven tests). They do not talk to each other.

Build the join: a single function that reads ops/BACKLOG.md, runs the picker,
feeds its package to the consumer, and returns either an accepted package or
the consumer's typed refusal. That is the Garden's smallest complete loop —
propose, judge, accept-or-refuse — and nothing exercises it end to end today.

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
