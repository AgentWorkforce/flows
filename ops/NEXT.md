# NEXT — Gate 3: Work package validator

**Pinned to gate 3** (ops/TARGET.md)

## Scope

> Close the gap between the Garden's two halves. CODE task, SDK-side.
>
> On main: `sdk/src/backlog-picker.ts` proposes a work package from
> ops/BACKLOG.md (four tested properties).
>
> NOT on main: the consumer that judges a package. It exists in open PR #23
> (`sdk/src/work-package-consumer.ts`, seven tests) and has not been merged. An
> earlier version of this brief claimed it was on main; a run took that at face
> value, found only one half of the pair, and correctly escalated rather than
> inventing the other. It was right and the brief was wrong.
>
> Build the consumer's counterpart that CAN be built against main today: a
> validator for what the picker emits, living beside the picker, that returns
> either an accepted package or a typed refusal naming what is missing (no title,
> empty scope, no definition of done). Do not import from PR #23 — it is not
> merged, and a run must build against main, not against an open branch.
>
> That is the Garden's smallest complete loop — propose, judge, accept-or-refuse
> — and nothing exercises it end to end today.

## Objective

Build a validator function for work packages that lives in `sdk/src/backlog-picker.ts`
(beside the picker, not importing from the unmerged PR #23). The validator must:

1. Accept a work package with title, scope, and definition of done
2. Refuse with typed reasons when:
   - No title (or empty title)
   - No scope (or empty scope)
   - No definition of done (or empty definition of done)

## Files in scope

- `sdk/src/backlog-picker.ts` — add validator function
- `sdk/src/index.ts` — export the validator
- `sdk/tests/backlog-picker.test.ts` or new test file — tests for validation

## Definition of done

**All of these commands must pass and be quoted with literal output:**

1. A new exported validator function exists in sdk/src/backlog-picker.ts
2. The function is exported from sdk/src/index.ts
3. Tests exist covering:
   - A backlog yielding an acceptable package
   - A backlog yielding a package the validator refuses
   - An empty backlog
4. **Every new test CONFIRMED TO FAIL without the fix**, with failing output quoted
5. Command that must pass:
   ```
   cd /project/workflows/runs/06163551-8818-4d54-939f-5363183ca903/sdk && npm test
   ```
   Quote the literal output showing test counts.
6. **Final action** — run and quote:
   ```
   git status --porcelain
   ```

## Out of scope

- Do NOT touch kernel/
- Do NOT touch sdk/src/demo-hn-monitor.ts
- Do NOT touch anything under ops/
- Do NOT import from sdk/src/work-package-consumer.ts (PR #23, not merged)
