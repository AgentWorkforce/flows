# Event Await — Surface and SDK slice

Commit: `73f32ad13abc0d99c79f14f8b99fbce3de03d82f` (`feat(surface): add bounded event activities`)

Scope: the authored TypeScript surface and direct-run adapter only. This adds
`Ctx.on(source, options): Activity`, required `idle` and `deadline` typing and
runtime validation, journal protocol lowering (`subscription.open`,
`subscription.next`, `subscription.close`), strict `Wake` decoding, and
automatic close on terminal body lifecycle. It does not claim kernel timer,
router binding, ingress replay, dedupe, overflow, or recovery behavior.

`packages/schema/flows.schema.json` was inspected and intentionally unchanged:
it is generated from declarative `FlowSpec`; body-level `Ctx` operations are
TypeScript authored code and have no declarative schema representation.

## Commands and captured output

Command (initial invocation, exit 254):

```text
cd /Volumes/Paris Drive/AgentWorkforce/.worktrees/flows-v2-lead-0913/event-await-flows-overnight-0917
npm run typecheck --workspace=@relayflows/surface && npm run typecheck --workspace=@relayflows/sdk

npm error code ENOENT
npm error syscall open
npm error path /Volumes/Paris Drive/AgentWorkforce/.worktrees/flows-v2-lead-0913/event-await-flows-overnight-0917/package.json
npm error errno -2
npm error Could not read package.json: Error: ENOENT: no such file or directory, open '/Volumes/Paris Drive/AgentWorkforce/.worktrees/flows-v2-lead-0913/event-await-flows-overnight-0917/package.json'
```

Blocker resolved locally: this repository has no root `package.json`; the SDK
also initially had no local dependencies. `cd packages/sdk && npm ci
--ignore-scripts` restored only lockfile-pinned local dependencies. It reported
six dependency audit findings (4 moderate, 1 high, 1 critical); no `npm audit
fix`, credential, configuration, publish, deploy, or remote action was run.

Command (exit 0):

```text
cd packages/surface && npm run typecheck && npm run build && npx vitest run tests/activity.test.ts

> @relayflows/surface@2.0.14 typecheck
> tsc --noEmit

> @relayflows/surface@2.0.14 build
> tsc

 RUN  v2.1.9 .../packages/surface

 ✓ tests/activity.test.ts (1 test) 1ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
```

Command (exit 0):

```text
cd packages/sdk && npm run typecheck && npx vitest run tests/authored-flow.test.ts tests/authored-activity.test.ts tests/activity-preflight.test.ts && git diff --check

> @relayflows/sdk@2.0.14 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json

 RUN  v2.1.9 .../packages/sdk

 ✓ tests/activity-preflight.test.ts (1 test) 6ms
 ✓ tests/authored-activity.test.ts (8 tests) 20ms
 ✓ tests/authored-flow.test.ts (25 tests) 686ms

 Test Files  3 passed (3)
      Tests  34 passed (34)
```

The final `git diff --check` produced no output and exited 0.

## Focused coverage

- `packages/surface/tests/activity.test.ts`: public type contract, all `Wake`
  variants, and compile-time rejection of either missing required bound.
- `packages/sdk/tests/activity-preflight.test.ts`: `flows check`-side static
  refusal with `unbounded_subscription` for a literal `f.on` missing a bound.
- `packages/sdk/tests/authored-activity.test.ts`: protocol lowering, events / idle
  / deadline / overflow result decoding, malformed result refusal, automatic
  run-completion closure, and no reopening after explicit `close()`.
