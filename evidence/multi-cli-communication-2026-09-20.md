# CLI-independent communication follow-up

This supersedes the Claude-only scope in the earlier report. The bridge sends each declared CLI and its exact executable to Relay, with no Flows CLI allowlist or Claude permission flags. Relay owns CLI-specific launch behavior. Ordinary non-communication preflight is unchanged. Unknown managed-CLI authentication is explicitly unverified, not a synthetic pass. The exhaustive warning test gained an input scenario; its assertions were not weakened.

Live mixed-CLI success: `01M2YXDB40JH221ZPJA6M5GR71`, Claude → Codex → Cursor → Claude. The five-tool ring did not complete: Gemini lacked Google authentication; OpenCode exhausted its default free-model quota. An explicit OpenAI-model attempt in OpenCode reached the configured provider and rejected its API key. Those runs were canceled or failed; none is claimed successful.

## multi-cli-build.txt

```text
cwd: /tmp/flows-relay-communication
$ npm --prefix packages/sdk run build

> @relayflows/sdk@2.0.22 build
> tsc && node scripts/make-cli-executable.mjs


exit status: 0
```

## multi-cli-tests-3.txt

```text
cwd: /tmp/flows-relay-communication/packages/sdk
$ env RELAYFLOWD_BIN=/tmp/flows-pr-cleanup/pr499/kernel/target/debug/relayflowd ./node_modules/.bin/vitest run tests/communication-worker.test.ts tests/communication-preflight.test.ts tests/communication-lazy.test.ts tests/communication.test.ts tests/preflight.test.ts tests/yaml-local-agent-live.test.ts

 RUN  v2.1.9 /tmp/flows-relay-communication/packages/sdk

 ✓ tests/communication.test.ts (10 tests) 10ms
 ✓ tests/communication-lazy.test.ts (1 test) 4ms
 ✓ tests/communication-preflight.test.ts (12 tests) 18ms
 ✓ tests/preflight.test.ts (57 tests) 65ms
 ✓ tests/communication-worker.test.ts (14 tests) 1389ms
 ✓ tests/yaml-local-agent-live.test.ts (7 tests) 2983ms
   ✓ YAML --local-agent through the built CLI and real daemon > runs with the checked step CLI and model and journals done 491ms
   ✓ YAML --local-agent through the built CLI and real daemon > runs with the checked named CLI and model and journals done 457ms
   ✓ YAML --local-agent through the built CLI and real daemon > runs with the checked flow CLI and model and journals done 448ms
   ✓ YAML --local-agent through the built CLI and real daemon > runs with the checked project CLI and model and journals done 381ms
   ✓ YAML --local-agent through the built CLI and real daemon > still parks without --local-agent 382ms
   ✓ YAML --local-agent through the built CLI and real daemon > reports the agent process failure 448ms
   ✓ YAML --local-agent through the built CLI and real daemon > preserves declared workspace surfaces that the local worker cannot pin 375ms

 Test Files  6 passed (6)
      Tests  101 passed (101)
   Start at  01:02:03
   Duration  3.29s (transform 804ms, setup 0ms, collect 2.11s, tests 4.47s, environment 1ms, prepare 436ms)


exit status: 0
```

## multi-cli-typecheck.txt

```text
cwd: /tmp/flows-relay-communication
$ npm --prefix packages/sdk run typecheck

> @relayflows/sdk@2.0.22 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json


exit status: 0
```

## multi-cli-test-types.txt

```text
cwd: /tmp/flows-relay-communication
$ npm --prefix packages/sdk run typecheck:tests

> @relayflows/sdk@2.0.22 typecheck:tests
> tsc -p tsconfig.tests.json


exit status: 0
```

## multi-cli-verification.txt

```text
cwd: /tmp/flows-relay-communication
$ python scripts/verify-mixed-cli-communication.py /tmp/flows-multi-cli/data-3/runs/01M2YXDB40JH221ZPJA6M5GR71.sqlite3
{
  "run_id": "01M2YXDB40JH221ZPJA6M5GR71",
  "clis": {
    "claude": "claude",
    "codex": "codex",
    "cursor": "cursor-agent"
  },
  "appends": 3,
  "deliveries": 3,
  "processing_acks": 3,
  "successful_agents": 3,
  "completionReason": "success"
}

exit status: 0
```

## multi-cli-environment-blockers.txt

```text
cwd: /tmp/flows-relay-communication
$ python /tmp/flows-multi-cli/verify-blockers.py
{
  "gemini": "Google authentication consent unavailable",
  "opencode_default": "free usage exceeded",
  "opencode_openai": "configured API key rejected",
  "opencode_injection": "observed in CLI output; no successful processing acknowledgement claimed"
}

exit status: 0
```

Routing tests exercise Claude, Codex, Gemini, Cursor, Droid, OpenCode, Aider, Goose, Grok, Pi, DeepAgents, and a custom path. This is contract coverage, not live end-to-end proof for every tool. Remaining live tool coverage needs installed/authenticated CLIs and available provider quota.

## multi-cli-build-final.txt

```text
cwd: /tmp/flows-relay-communication
$ npm --prefix packages/sdk run build

> @relayflows/sdk@2.0.22 build
> tsc && node scripts/make-cli-executable.mjs


exit status: 0
```

## multi-cli-tests-final.txt

```text
cwd: /tmp/flows-relay-communication/packages/sdk
$ env RELAYFLOWD_BIN=/tmp/flows-pr-cleanup/pr499/kernel/target/debug/relayflowd ./node_modules/.bin/vitest run tests/communication-worker.test.ts tests/communication-preflight.test.ts tests/communication-lazy.test.ts tests/communication.test.ts tests/preflight.test.ts tests/yaml-local-agent-live.test.ts

 RUN  v2.1.9 /tmp/flows-relay-communication/packages/sdk

 ✓ tests/communication.test.ts (10 tests) 9ms
 ✓ tests/communication-lazy.test.ts (1 test) 4ms
 ✓ tests/communication-preflight.test.ts (12 tests) 22ms
 ✓ tests/preflight.test.ts (57 tests) 60ms
 ✓ tests/communication-worker.test.ts (15 tests) 1499ms
 ✓ tests/yaml-local-agent-live.test.ts (7 tests) 2945ms
   ✓ YAML --local-agent through the built CLI and real daemon > runs with the checked step CLI and model and journals done 497ms
   ✓ YAML --local-agent through the built CLI and real daemon > runs with the checked named CLI and model and journals done 460ms
   ✓ YAML --local-agent through the built CLI and real daemon > runs with the checked flow CLI and model and journals done 431ms
   ✓ YAML --local-agent through the built CLI and real daemon > runs with the checked project CLI and model and journals done 456ms
   ✓ YAML --local-agent through the built CLI and real daemon > reports the agent process failure 421ms
   ✓ YAML --local-agent through the built CLI and real daemon > preserves declared workspace surfaces that the local worker cannot pin 386ms

 Test Files  6 passed (6)
      Tests  102 passed (102)
   Start at  01:09:43
   Duration  3.27s (transform 780ms, setup 0ms, collect 2.14s, tests 4.54s, environment 1ms, prepare 394ms)


exit status: 0
```
