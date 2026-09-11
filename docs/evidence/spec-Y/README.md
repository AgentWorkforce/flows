# Slice Y local verification

Structured `f.slack.post` messages and options preserve blocks, attachments,
fallback text, and `replyTo` through the SDK writeback transport. Plain-text
calls retain their existing body and receipt shapes. No interaction handlers
or callback registration are introduced.

## Upstream type availability

The installed, pinned `@relayfile/relay-helpers` 0.4.11 declaration and the local
adapter checkout expose a text-only `SlackClient.post`; neither exports the
OpenAPI types described in the brief. The implementation therefore generates
the outer message shapes from checked-in Slack OpenAPI fragments instead.
See `scripts/slack-message-schema.json` for source URL, retrieval date, and JSON
pointers, and `packages/surface/src/helpers/README.md` for the resulting typing
limits. Nested block layouts and attachment fields remain open in that schema.

## Passing checks

Working directory: `packages/surface`.

```sh
PATH=/Users/khaliqgant/.bun/bin:$PATH npm run typecheck
PATH=/Users/khaliqgant/.bun/bin:$PATH npm test
npm run typecheck:regressions
npm run typecheck:examples
```

Captured output excerpts (all commands exited 0):

```text
> @relayflows/surface@2.0.8 typecheck
> tsc --noEmit

 Test Files  4 passed (4)
      Tests  30 passed (30)

HELPERS_GENERATED_OK index.ts, slack.ts

> @relayflows/surface@2.0.8 typecheck:examples
> tsc -p ../../examples/tsconfig.json
```

Working directory: `packages/sdk`.

```sh
npm run typecheck
npm run build
npm run typecheck:tests
./node_modules/.bin/vitest run tests/slack-block-kit.test.ts tests/slack-writeback.test.ts
```

Captured output excerpts (all commands exited 0):

```text
> @relayflows/sdk@2.0.8 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json

> @relayflows/sdk@2.0.8 build
> tsc && node scripts/make-cli-executable.mjs

> @relayflows/sdk@2.0.8 typecheck:tests
> tsc -p tsconfig.tests.json

 Test Files  2 passed (2)
      Tests  6 passed (6)
```

## Checks blocked by the environment

Working directory: `packages/sdk`.

```sh
RELAYFLOWD_BIN=/Users/khaliqgant/.relayflows-toolchain/target/3923540030/debug/relayflowd ./node_modules/.bin/vitest run tests/authored-flow-slack.test.ts
```

Captured output excerpts (exit 1):

```text
Error: Error: bind socket /var/folders/_z/f_fpl8j533g_r63706k2xvp00000gn/T/relayflowd-3a67e6a9f2c0.sock

Caused by:
    Operation not permitted (os error 1)

 Test Files  1 failed (1)
      Tests  5 failed | 2 passed (7)
```

The sandbox refused socket binding for the added journal snapshot test and
four existing Slack tests. This does not establish a passing daemon integration
run; the new test still needs execution in an environment that permits sockets.

```sh
PATH=/Users/khaliqgant/.cargo/bin:/Users/khaliqgant/.bun/bin:$PATH npm test
```

Captured output excerpt (exit 101 during the prerequisite Rust build):

```text
error: failed to build archive at `/Users/khaliqgant/.relayflows-toolchain/target/2234480737/debug/deps/librelayflowd-b546e1c22a21bac5.rlib`: No space left on device (os error 28)

error: could not compile `relayflowd` (lib) due to 1 previous error
```

The build artifacts created by this failed attempt were removed. The full SDK
suite has not passed locally; no tests were disabled to bypass these failures.
