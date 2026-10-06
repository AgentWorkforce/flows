Cloud human gates now surface as `needs_human` with exit 3, and `flows answer --cloud <run-id> yes|no` records the decision and resumes with the original source/authority and no `inputs`.

- Shared validation covers `run --wait`, `status --watch`, and `logs --follow`. The waiter displays the scrubbed question, recipient and Cloud answer command; watch renders the park.
- Answer preflight discovers the wait, verifies source SHA-256 before any write, and preserves the record's authority and workspace. `--source` accepts original local/synced bytes without executing them. Reported synced trees and extensions refuse until their full restore contract is available.
- After recording an answer, a fresh GET suppresses the resume POST when Cloud visibly resumed. Identical recorded answers permit recovery without a second answer POST. Partial success reports `answerRecorded` and a retry command; POSTs are never automatically retried.
- Public `CloudRunState` gains a distinct `needs_human` variant; kernel completion vocabulary is unchanged. New SDK answer/receipt types are exported. Existing per-verb JSON `ok` meanings are preserved.
- Reviewed-plan F1 resolution: preserve the ticket's two-positional Cloud syntax and the existing three-positional local syntax using `<run-id> <wait-id-or-answer> [answer]` in the shared command declaration. This avoids an optional middle positional. Existing local usage remains unchanged; command conformance and both arities are covered.

Limits: no hosted run was executed. The answer-route shapes, full stored source availability, authority acceptance, workspace requirements, and successor-run behavior remain unconfirmed against production. The GET guard is not an atomic claim and cannot prevent a concurrent resume or detect a successor if Cloud leaves the original record parked; server-side deduplication is required for that guarantee. Unsupported response shapes fail closed. The CLI is the scriptable fallback for delivered in-channel answering.

Verification commands below ran from `packages/sdk`. Dependencies were installed with `npm install --ignore-scripts`; the full gate runs its build prerequisites itself. Complete captured outputs are committed under `evidence/cloud-human-cli/`.

SDK types:

```sh
npm run typecheck
```

```text
> @relayflows/sdk@2.0.42 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json
```

Configured test types:

```sh
npm run typecheck:tests
```

```text
> @relayflows/sdk@2.0.42 typecheck:tests
> tsc -p tsconfig.tests.json
```

Focused regressions:

```sh
npx vitest run tests/cloud-run.test.ts tests/cloud-answer.test.ts tests/cli-answer.test.ts tests/relay-cli-surface.test.ts tests/cloud-live.test.ts
```

```text
RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ✓ tests/relay-cli-surface.test.ts (88 tests) 44ms
 ✓ tests/cloud-answer.test.ts (24 tests) 32ms
 ✓ tests/cloud-run.test.ts (69 tests) 1236ms
   ✓ hosted v2 submission > refuses declarative input plus omitted or undefined authored input before HTTP 307ms
 ✓ tests/cli-answer.test.ts (24 tests) 12ms
 ✓ tests/cloud-live.test.ts (58 tests) 2098ms
   ✓ argv and wiring > routes both live invocations through runCli, and refuses a missing run id 2006ms

 Test Files  5 passed (5)
      Tests  263 passed (263)
   Start at  19:03:42
   Duration  4.32s (transform 1.47s, setup 85ms, collect 7.11s, tests 3.42s, environment 1ms, prepare 305ms)
```

Mutation verification of the reported waiter defect: saved the changed `cloud-run-record.ts` bytes, replaced that file with `git show HEAD:packages/sdk/src/cloud-run-record.ts`, ran the command below, restored the saved bytes with an equality assertion, then ran the same command again. Only the validator was reverted; the regression remained in place. Subsequent changes to that validator were comments only.

```sh
npx vitest run tests/cloud-run.test.ts -t 'waiter returns needs_human instead of invalid_response'
```

Old validator (exit 1):

```text
RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ❯ tests/cloud-run.test.ts (69 tests | 1 failed | 68 skipped) 11ms
   × Cloud human park > waiter returns needs_human instead of invalid_response 10ms
     → Cloud terminal record lacks a valid, consistent run completionReason; no execution outcome is attested.

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/cloud-run.test.ts > Cloud human park > waiter returns needs_human instead of invalid_response
CloudFlowError: Cloud terminal record lacks a valid, consistent run completionReason; no execution outcome is attested.
 ❯ Module.cloudRunState src/cloud-run-record.ts:61:11
     59|     || (body.status === 'failed' && !['step_failed', 'budget_exceeded'…
     60|     || (body.status === 'cancelled' && reason !== 'canceled')) {
     61|     throw new CloudFlowError('invalid_response', 'Cloud terminal recor…
       |           ^
     62|   }
     63|   return { runId, status: body.status as 'completed' | 'failed' | 'can…
 ❯ getCloudFlowRun src/cloud-run.ts:277:10
 ❯ Module.waitForCloudFlowRun src/cloud-run.ts:293:19
 ❯ tests/cloud-run.test.ts:513:12

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 68 skipped (69)
   Start at  18:59:10
   Duration  2.14s (transform 1.23s, setup 18ms, collect 1.93s, tests 11ms, environment 0ms, prepare 57ms)
```

Restored validator (exit 0):

```text
RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ✓ tests/cloud-run.test.ts (69 tests | 68 skipped) 6ms

 Test Files  1 passed (1)
      Tests  1 passed | 68 skipped (69)
   Start at  18:59:22
   Duration  2.13s (transform 1.27s, setup 16ms, collect 1.93s, tests 6ms, environment 0ms, prepare 43ms)
```

Full gate: **incomplete, not passing**. Ran `npm test`, then stopped Vitest with `kill -INT 12018` after it reported live-kernel assertion failures, an unavailable analyzer, missing bubblewrap, and missing local Surface build files. The process exited 130. No baseline comparison was run, so these are not asserted to be pre-existing failures. The focused Cloud suites and configured type checks above are the passing evidence for this change; this is not full-gate signoff.

```sh
npm test
```

<details>
<summary>Captured full-gate output through interruption</summary>

```text
> @relayflows/sdk@2.0.42 test
> sh scripts/test.sh


> @relayflows/sdk@2.0.42 test:prep
> ( cd ../../kernel && sh ../ops/cargo.sh build ) && ( [ ! -d ../../testdata/preflight ] || find ../../testdata/preflight -name '*-cli' -type f -exec chmod +x {} + )

CARGO_BOOTSTRAP: no toolchain found — installing rustup into /home/daytona/.relayflows-toolchain
info: downloading installer
info: profile set to minimal
info: default host tuple is x86_64-unknown-linux-gnu
info: syncing channel updates for stable-x86_64-unknown-linux-gnu
info: latest update on 2026-10-01 for version 1.99.0 (b940084d7 2026-09-28)
info: downloading 3 components
info: default toolchain set to stable-x86_64-unknown-linux-gnu

  stable-x86_64-unknown-linux-gnu installed - rustc 1.99.0 (b940084d7 2026-09-28)


Rust is installed now. Great!

To get started you need Cargo's bin directory 
(/home/daytona/.relayflows-toolchain/cargo/bin) in your PATH
environment variable. This has not been done automatically.

To configure your current shell, you need to source
the corresponding env file under /home/daytona/.relayflows-toolchain/cargo.

Consider running the right command for your shell (note the leading DOT):
. "/home/daytona/.relayflows-toolchain/cargo/env" # For 
sh/ash/dash/pdksh/bash/zsh
cargo:rerun-if-env-changed=CC_x86_64-unknown-linux-gnu
CC_x86_64-unknown-linux-gnu = None
cargo:rerun-if-env-changed=CC_x86_64_unknown_linux_gnu
CC_x86_64_unknown_linux_gnu = None
cargo:rerun-if-env-changed=HOST_CC
HOST_CC = None
cargo:rerun-if-env-changed=CC
CC = None
cargo:rerun-if-env-changed=CC_ENABLE_DEBUG_OUTPUT
cargo:rerun-if-env-changed=CRATE_CC_NO_DEFAULTS
CRATE_CC_NO_DEFAULTS = None
cargo:rerun-if-env-changed=CFLAGS
CFLAGS = None
cargo:rerun-if-env-changed=HOST_CFLAGS
HOST_CFLAGS = None
cargo:rerun-if-env-changed=CFLAGS_x86_64_unknown_linux_gnu
CFLAGS_x86_64_unknown_linux_gnu = None
cargo:rerun-if-env-changed=CFLAGS_x86_64-unknown-linux-gnu
CFLAGS_x86_64-unknown-linux-gnu = None
CARGO_BOOTSTRAP_OK: cargo 1.99.0 (5f94df478 2026-08-27)
    Updating crates.io index
 Downloading crates ...
  Downloaded clap_derive v4.6.4
  Downloaded borrow-or-share v0.2.4
  Downloaded cfg-if v1.0.4
  Downloaded crypto-common v0.1.7
  Downloaded foldhash v0.1.5
  Downloaded idna_adapter v1.2.2
  Downloaded anstream v1.0.0
  Downloaded anstyle v1.0.14
  Downloaded anstyle-parse v1.0.0
  Downloaded anyhow v1.0.104
  Downloaded autocfg v1.5.1
  Downloaded bit-set v0.8.0
  Downloaded block-buffer v0.10.4
  Downloaded clap_lex v1.1.0
  Downloaded digest v0.10.7
  Downloaded rand_chacha v0.9.0
  Downloaded ahash v0.8.12
  Downloaded anstyle-query v1.1.5
  Downloaded cpufeatures v0.2.17
  Downloaded generic-array v0.14.7
  Downloaded base64 v0.22.1
  Downloaded clap v4.6.6
  Downloaded find-msvc-tools v0.1.11
  Downloaded bytecount v0.6.9
  Downloaded thiserror-impl v2.0.20
  Downloaded fallible-streaming-iterator v0.1.9
  Downloaded hashlink v0.10.0
  Downloaded itoa v1.0.18
  Downloaded num-rational v0.4.2
  Downloaded bit-vec v0.8.0
  Downloaded heck v0.5.0
  Downloaded is_terminal_polyfill v1.70.2
  Downloaded wait-timeout v0.2.1
  Downloaded colorchoice v1.0.5
  Downloaded num-cmp v0.1.0
  Downloaded num-iter v0.1.46
  Downloaded fallible-iterator v0.3.0
  Downloaded icu_collections v2.3.0
  Downloaded version_check v0.9.5
  Downloaded writeable v0.6.4
  Downloaded bitflags v2.13.1
  Downloaded fluent-uri v0.3.2
  Downloaded lock_api v0.4.14
  Downloaded num-traits v0.2.19
  Downloaded ref-cast-impl v1.0.27
  Downloaded zerofrom v0.1.8
  Downloaded num v0.4.3
  Downloaded rand_core v0.9.5
  Downloaded referencing v0.33.0
  Downloaded scopeguard v1.2.0
  Downloaded serde_derive v1.0.229
  Downloaded smallvec v1.15.2
  Downloaded strsim v0.11.1
  Downloaded zerofrom-derive v0.1.7
  Downloaded zerovec v0.11.8
  Downloaded zerovec-derive v0.11.6
  Downloaded zmij v1.0.23
  Downloaded cc v1.4.4
  Downloaded displaydoc v0.2.7
  Downloaded email_address v0.2.9
  Downloaded getrandom v0.3.4
  Downloaded icu_normalizer_data v2.3.0
  Downloaded icu_provider v2.3.1
  Downloaded lazy_static v1.5.0
  Downloaded num-complex v0.4.6
  Downloaded outref v0.5.2
  Downloaded quote v1.0.47
  Downloaded ref-cast v1.0.27
  Downloaded vsimd v0.8.0
  Downloaded yoke v0.8.3
  Downloaded yoke-derive v0.8.2
  Downloaded fraction v0.15.4
  Downloaded icu_locale_core v2.3.0
  Downloaded potential_utf v0.1.6
  Downloaded icu_properties v2.3.0
  Downloaded percent-encoding v2.3.2
  Downloaded zerotrie v0.2.5
  Downloaded num-integer v0.1.47
  Downloaded idna v1.1.0
  Downloaded memchr v2.8.3
  Downloaded shlex v2.0.1
  Downloaded fancy-regex v0.16.2
  Downloaded ppv-lite86 v0.2.21
  Downloaded hashbrown v0.15.5
  Downloaded once_cell v1.21.4
  Downloaded stable_deref_trait v1.2.1
  Downloaded tinystr v0.8.4
  Downloaded zerocopy v0.8.56
  Downloaded aho-corasick v1.1.5
  Downloaded litemap v0.8.3
  Downloaded parking_lot v0.12.5
  Downloaded utf8_iter v1.0.4
  Downloaded utf8parse v0.2.2
  Downloaded pkg-config v0.3.34
  Downloaded rand v0.9.5
  Downloaded serde_core v1.0.229
  Downloaded icu_properties_data v2.3.0
  Downloaded proc-macro2 v1.0.107
  Downloaded parking_lot_core v0.9.12
  Downloaded sha2 v0.10.9
  Downloaded synstructure v0.13.2
  Downloaded thiserror v2.0.20
  Downloaded uuid-simd v0.8.0
  Downloaded clap_builder v4.6.6
  Downloaded jsonschema v0.33.0
  Downloaded ryu-js v1.0.3
  Downloaded serde v1.0.229
  Downloaded uuid v1.26.0
  Downloaded num-bigint v0.4.8
  Downloaded serde_json v1.0.151
  Downloaded regex v1.13.1
  Downloaded unicode-ident v1.0.24
  Downloaded ulid v1.2.1
  Downloaded typenum v1.20.1
  Downloaded syn v2.0.119
  Downloaded vcpkg v0.2.15
  Downloaded rusqlite v0.37.0
  Downloaded syn v3.0.4
  Downloaded regex-syntax v0.8.11
  Downloaded icu_normalizer v2.3.0
  Downloaded regex-automata v0.4.18
  Downloaded libc v0.2.189
  Downloaded libsqlite3-sys v0.35.0
   Compiling proc-macro2 v1.0.107
   Compiling quote v1.0.47
   Compiling unicode-ident v1.0.24
   Compiling stable_deref_trait v1.2.1
   Compiling libc v0.2.189
   Compiling version_check v0.9.5
   Compiling cfg-if v1.0.4
   Compiling autocfg v1.5.1
   Compiling serde_core v1.0.229
   Compiling zerocopy v0.8.56
   Compiling num-traits v0.2.19
   Compiling syn v3.0.4
   Compiling syn v2.0.119
   Compiling getrandom v0.3.4
   Compiling serde v1.0.229
   Compiling smallvec v1.15.2
   Compiling synstructure v0.13.2
   Compiling zerofrom-derive v0.1.7
   Compiling yoke-derive v0.8.2
   Compiling zerofrom v0.1.8
   Compiling litemap v0.8.3
   Compiling yoke v0.8.3
   Compiling writeable v0.6.4
   Compiling memchr v2.8.3
   Compiling num-integer v0.1.47
   Compiling zerovec-derive v0.11.6
   Compiling displaydoc v0.2.7
   Compiling serde_derive v1.0.229
   Compiling generic-array v0.14.7
   Compiling zerotrie v0.2.5
   Compiling icu_normalizer_data v2.3.0
   Compiling utf8_iter v1.0.4
   Compiling icu_properties_data v2.3.0
   Compiling zerovec v0.11.8
   Compiling parking_lot_core v0.9.12
   Compiling typenum v1.20.1
   Compiling ref-cast v1.0.27
   Compiling zmij v1.0.23
   Compiling tinystr v0.8.4
   Compiling potential_utf v0.1.6
   Compiling icu_collections v2.3.0
   Compiling icu_locale_core v2.3.0
   Compiling aho-corasick v1.1.5
   Compiling ref-cast-impl v1.0.27
   Compiling icu_provider v2.3.1
   Compiling num-bigint v0.4.8
   Compiling ahash v0.8.12
   Compiling shlex v2.0.1
   Compiling regex-syntax v0.8.11
   Compiling find-msvc-tools v0.1.11
   Compiling scopeguard v1.2.0
   Compiling serde_json v1.0.151
   Compiling lock_api v0.4.14
   Compiling num-rational v0.4.2
   Compiling cc v1.4.4
   Compiling icu_normalizer v2.3.0
   Compiling regex-automata v0.4.18
   Compiling icu_properties v2.3.0
   Compiling ppv-lite86 v0.2.21
   Compiling num-iter v0.1.46
   Compiling rand_core v0.9.5
   Compiling num-complex v0.4.6
   Compiling itoa v1.0.18
   Compiling vcpkg v0.2.15
   Compiling borrow-or-share v0.2.4
   Compiling once_cell v1.21.4
   Compiling bit-vec v0.8.0
   Compiling pkg-config v0.3.34
   Compiling bit-set v0.8.0
   Compiling num v0.4.3
   Compiling fluent-uri v0.3.2
   Compiling libsqlite3-sys v0.35.0
   Compiling rand_chacha v0.9.0
   Compiling idna_adapter v1.2.2
   Compiling parking_lot v0.12.5
   Compiling block-buffer v0.10.4
   Compiling crypto-common v0.1.7
   Compiling thiserror v2.0.20
   Compiling lazy_static v1.5.0
   Compiling utf8parse v0.2.2
   Compiling vsimd v0.8.0
   Compiling outref v0.5.2
   Compiling foldhash v0.1.5
   Compiling percent-encoding v2.3.2
   Compiling uuid v1.26.0
   Compiling referencing v0.33.0
   Compiling hashbrown v0.15.5
   Compiling uuid-simd v0.8.0
   Compiling anstyle-parse v1.0.0
   Compiling fraction v0.15.4
   Compiling digest v0.10.7
   Compiling idna v1.1.0
   Compiling fancy-regex v0.16.2
   Compiling regex v1.13.1
   Compiling rand v0.9.5
   Compiling email_address v0.2.9
   Compiling thiserror-impl v2.0.20
   Compiling num-cmp v0.1.0
   Compiling is_terminal_polyfill v1.70.2
   Compiling anstyle-query v1.1.5
   Compiling base64 v0.22.1
   Compiling colorchoice v1.0.5
   Compiling anstyle v1.0.14
   Compiling cpufeatures v0.2.17
   Compiling bytecount v0.6.9
   Compiling sha2 v0.10.9
   Compiling jsonschema v0.33.0
   Compiling anstream v1.0.0
   Compiling ulid v1.2.1
   Compiling hashlink v0.10.0
   Compiling ryu-js v1.0.3
   Compiling strsim v0.11.1
   Compiling clap_lex v1.1.0
   Compiling anyhow v1.0.104
   Compiling heck v0.5.0
   Compiling bitflags v2.13.1
   Compiling fallible-streaming-iterator v0.1.9
   Compiling fallible-iterator v0.3.0
   Compiling clap_derive v4.6.4
   Compiling clap_builder v4.6.6
   Compiling relayflowd-core v0.1.0 (/home/daytona/.relayflow-v2-supervisor/durable/repository/kernel/relayflowd-core)
   Compiling clap v4.6.6
   Compiling wait-timeout v0.2.1
   Compiling rusqlite v0.37.0
   Compiling relayflowd-journal v0.1.0 (/home/daytona/.relayflow-v2-supervisor/durable/repository/kernel/relayflowd-journal)
   Compiling relayflowd v0.1.0 (/home/daytona/.relayflow-v2-supervisor/durable/repository/kernel/relayflowd)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 23.43s

> @relayflows/sdk@2.0.42 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json


> @relayflows/sdk@2.0.42 build
> tsc && node scripts/make-cli-executable.mjs


> @relayflows/sdk@2.0.42 typecheck:tests
> tsc -p tsconfig.tests.json


 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

stdout | tests/live-kernel.test.ts
LIVE_KERNEL relayflowd=/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd
LIVE_KERNEL flows=/home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk/dist/cli.js

 ✓ tests/preflight.test.ts (70 tests) 134ms
 ✓ tests/cli.test.ts (71 tests) 2872ms
   ✓ flows check CLI > binds a checked relative wrapper to the flow directory for worker execution 473ms
   ✓ flows check CLI > resolves a bare PATH-resolved claude with no declared model, in an isolated PATH 442ms
   ✓ flows run/resume CLI over the journal protocol > follows a worker wait past a locally expired lease until the daemon settles it 1042ms
 ✓ tests/cloud-read.test.ts (46 tests) 54ms
stdout | tests/live-kernel.test.ts > surface resume after a real daemon kill > resumes a three-step run with each successful completion exactly once
LIVE_KERNEL kill -9 pid=13548 run=01M499FYB1HH7BK7FC7GZ090W6 while step=two state=Running

 ❯ tests/live-kernel.test.ts (32 tests | 9 failed) 59308ms
   ✓ built flows CLI against live relayflowd > twenty-six-step reuses 25 durable completions after editing the failed final step 2434ms
   ✓ built flows CLI against live relayflowd > runs rung (a), parks rung (b), and keeps JSON report-shaped 2911ms
   ✓ built flows CLI against live relayflowd > allows a deterministic run to exceed the bounded request timeout 32582ms
   ✓ built flows CLI against live relayflowd > follows a live worker dispatch through flows run 653ms
   ✓ built flows CLI against live relayflowd > runs an agent CLI end to end through the SDK worker 756ms
   ✓ built flows CLI against live relayflowd > f.agent lowers to a real agent step and dispatches through a live worker 705ms
   ✓ built flows CLI against live relayflowd > can always get a parked run to a late-attaching worker 5587ms
   ✓ built flows CLI against live relayflowd > reports a real manual-recovery NeedsHuman state as parked 555ms
   × built flows CLI against live relayflowd > runs hn-monitor analyze-story end-to-end via a stub agent CLI (gate 2 clause 2 demo) 696ms
     → expected { …(12) } to match object { output: { …(3) }, …(1) }
(22 matching properties omitted from actual)
   × built flows CLI against live relayflowd > hn-monitor analyze-story FAILS verification when the CLI omits required schema fields 705ms
     → expected { …(12) } to match object { …(3) }
(21 matching properties omitted from actual)
   × built flows CLI against live relayflowd > agent step preserves the CliResult wrapper as output when the CLI emits non-JSON text 666ms
     → expected null not to be null
   × built flows CLI against live relayflowd > AgentWorker exposes wake_context to the CLI via RELAYFLOW_WAKE_CONTEXT env var (real analyzer prerequisite) 771ms
     → Cannot read properties of null (reading 'story_title')
   × built flows CLI against live relayflowd > AgentWorker leaves RELAYFLOW_WAKE_CONTEXT UNSET when the run has no wake_context (undefined-vs-null pin) 643ms
     → Cannot read properties of null (reading 'env_present')
   ✓ built flows CLI against live relayflowd > AgentWorker passes a declared model to an identified wrapper as RELAYFLOW_MODEL 650ms
   ✓ built flows CLI against live relayflowd > AgentWorker refuses a nonconforming journal-submitted wrapper before exposing RELAYFLOW_MODEL 719ms
   ✓ built flows CLI against live relayflowd > AgentWorker executes the raw claude adapter with its real model flag 607ms
   ✓ built flows CLI against live relayflowd > AgentWorker executes the raw codex adapter with its real model flag 538ms
   × built flows CLI against live relayflowd > AgentWorker leaves RELAYFLOW_MODEL UNSET when the step declares no model 654ms
     → Cannot read properties of null (reading 'story_title')
   × built flows CLI against live relayflowd > hn-monitor analyze-story reaches done through the real Claude analyzer CLI 32ms
     → LIVE_ANALYZER_UNAVAILABLE: "/home/daytona/.relayflow-v2-supervisor/durable/repository/testdata/preflight/analyze-story-claude-cli" does not identify as relayflows-agent-cli-v1 — failing because gate-2 acceptance requires the real analyzer to execute. Set RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 only if this run is not gate evidence.
   ✓ built flows CLI against live relayflowd > preflights before journaling and names an unreachable socket 965ms
   × built flows CLI against live relayflowd > starts exactly one daemon when two runs race for one empty data dir 633ms
     → WARNING [unprovable_effects] Step "greet" command "echo" resolves, but its effects cannot be proven before execution.
WARNING [unprovable_effects] Step "shout" command "echo" resolves, but its effects cannot be proven before execution.
WARNING [editor_schema_missing] For editor validation, add this first line: # yaml-language-server: $schema=https://schema.relayflows.dev/v0.1/flows.schema.json
REFUSED [relayflowd_not_found] No relayflowd binary could be found. Install the runtime package for this host (@relayflows/runtime-linux-x64), or set RELAYFLOWD_BIN to a relayflowd executable. Tried: /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk/dist/relayflowd.
: expected 2 to be +0 // Object.is equality
   ✓ subprocess_gate output capture against live relayflowd > journals the gate command output and reports both tails 1211ms
   ✓ surface resume after a real daemon kill > resumes a three-step run with each successful completion exactly once 1446ms
   × a relayflow can be scheduled: tick source against live relayflowd > a tick spawns a real run whose step reports the SCHEDULED instant 1266ms
     → expected null to deeply equal { schedule_id: 'heartbeat-1m', …(3) }
 ✓ tests/cloud-live.test.ts (58 tests) 2074ms
   ✓ argv and wiring > routes both live invocations through runCli, and refuses a missing run id 2005ms
 ❯ tests/hosted-extension-isolation.test.ts (22 tests | 15 failed) 389ms
   × hosted extension capability isolation > executes the exact capability-only handler for a queued receipt 10ms
     → bubblewrap is unavailable
   × hosted extension capability isolation > executes the exact capability-only handler for a duplicate receipt 3ms
     → bubblewrap is unavailable
   × hosted extension capability isolation > launches through the captured process primitive after builtin export synchronization 6ms
     → promise rejected "Error: bubblewrap is unavailable { code: '…' }" instead of resolving
   × hosted extension capability isolation > ignores inherited launcher overrides and decodes manifests with the captured Buffer intrinsic 3ms
     → promise rejected "Error: bubblewrap is unavailable { code: '…' }" instead of resolving
   × hosted extension capability isolation > streams verified bytes when the live store is replaced and no writable staging path exists 279ms
     → promise rejected "Error: Hosted extension sandbox exited wi… { code: '…' }" instead of resolving
   × hosted extension capability isolation > mounts pinned private Surface bytes when the live package changes before launch 1ms
     → ENOENT: no such file or directory, copyfile '/home/daytona/.relayflow-v2-supervisor/durable/repository/packages/surface/dist/flow.js' -> '/tmp/hosted-surface-test-EgA03v/dist/flow.js'
   × hosted extension capability isolation > refuses Surface runtime bytes that differ from the reviewed pin before launch 1ms
     → ENOENT: no such file or directory, copyfile '/home/daytona/.relayflow-v2-supervisor/durable/repository/packages/surface/dist/flow.js' -> '/tmp/hosted-surface-test-SwF3jA/dist/flow.js'
   × hosted extension capability isolation > refuses oversized Surface files through the bounded descriptor reader 1ms
     → ENOENT: no such file or directory, copyfile '/home/daytona/.relayflow-v2-supervisor/durable/repository/packages/surface/dist/flow.js' -> '/tmp/hosted-surface-test-m9qfBN/dist/flow.js'
   × hosted extension capability isolation > shields verified Surface files before async settlement 1ms
     → ENOENT: no such file or directory, copyfile '/home/daytona/.relayflow-v2-supervisor/durable/repository/packages/surface/dist/flow.js' -> '/tmp/hosted-surface-test-zoBW2Y/dist/flow.js'
   × hosted extension capability isolation > preserves a typed host refusal while disclosing only a fixed marker to the child 5ms
     → expected Error: bubblewrap is unavailable { code: '…' } to be Error: private Cloud policy detail { code: '…' } // Object.is equality
   × hosted extension capability isolation > denies ambient credentials, host files, writes, network, subprocesses, and undeclared context verbs 8ms
     → bubblewrap is unavailable
   × hosted extension capability isolation > enforces OS address-space and data bounds on native Buffer allocation 7ms
     → expected Error: bubblewrap is unavailable { code: '…' } to match object { code: 'plugin_unsupported', …(1) }
   × hosted extension capability isolation > blocks extra handler fields and authority-bearing receipt fields at the parent port 3ms
     → expected Error: bubblewrap is unavailable { code: '…' } to match object { code: 'plugin_event_unroutable' }
   × hosted extension capability isolation > constructs adapter authority with the captured freeze intrinsic 2ms
     → bubblewrap is unavailable
   × hosted extension capability isolation > writes the Surface manifest and protocol without inherited toJSON behavior 2ms
     → promise rejected "Error: bubblewrap is unavailable { code: '…' }" instead of resolving
 ✓ tests/cloud-deploy.test.ts (117 tests) 3838ms
   ✓ deployToCloud > reports a missing or unloadable source as an input refusal (exit 2), before HTTP 338ms
   ✓ deployToCloud > refuses non-authored sources, empty sources, duplicate providers and a blank approver before HTTP 432ms
 ✓ tests/cloud-sync.test.ts (40 tests) 1094ms
 ✓ tests/observer-link.test.ts (44 tests) 208ms
 ✓ tests/authored-flow.test.ts (38 tests) 823ms
 ✓ tests/plugin-extension.test.ts (94 tests) 471ms
 ✓ tests/cloud-transcript-codex.test.ts (44 tests) 20ms
 ✓ tests/worker-cli.test.ts (25 tests) 28733ms
   ✓ registered CLI model defaults > passes the same priced Claude default to the real provider invocation 464ms
   ✓ registered CLI model defaults > uses the explicitly supplied agent environment for the provider subprocess 439ms
   ✓ registered CLI model defaults > dispatches canonical generic bytes with the preflight-proved adapter identity 462ms
   ✓ direct transport lifecycle evidence > classifies only the exact Codex stdin lifecycle signature as retryable 554ms
   ✓ direct transport lifecycle evidence > records a signal close separately from an ordinary nonzero exit 972ms
   ✓ direct transport lifecycle evidence > records a spawn error code without treating a missing executable as transient 512ms
   ✓ direct transport lifecycle evidence > journals classified lifecycle evidence and reports crashed instead of generic worker_error 609ms
   ✓ step discovery environment > names the run, step, attempt and an absolute data dir for a direct agent spawn 830ms
   ✓ step discovery environment > exports none of the four without a data dir, even when the worker inherited them 516ms
   ✓ wrapper discovery environment > sets the four names from the dispatch and still refuses ambient values and other secrets 467ms
   ✓ wrapper discovery environment > exports none of the four to a wrapper without a data dir, even when the worker inherited them 499ms
   ✓ custom wrapper execution identity > passes an explicit safe environment at identification and execution 538ms
   ✓ custom wrapper execution identity > refuses a wrapper symlink retarget before delivering private values 583ms
   ✓ custom wrapper execution identity > bounds wrapper execution after acknowledgement 515ms
   ✓ custom wrapper execution identity > bounds captured wrapper output 529ms
   ✓ custom wrapper execution identity > refuses a duplicate execute protocol frame 443ms
   ✓ custom wrapper execution bounds are reader-owned > resolves when a conforming wrapper leaks a stdio pipe to a background helper 1021ms
   ✓ custom wrapper execution bounds are reader-owned > resolves when the leaked helper inherits stderr only 724ms
   ✓ custom wrapper execution bounds are reader-owned > resolves when a wrapper leaks a stdio pipe and exits before identifying 3483ms
   ✓ custom wrapper execution bounds are reader-owned > journals a completionReason at the default bound when a wrapper leaks a stdio pipe 11522ms
   ✓ custom wrapper execution bounds are reader-owned > accepts an execute token and an over-8KiB payload flushed in one write 430ms
   ✓ custom wrapper execution bounds are reader-owned > accepts the same over-8KiB payload whether or not it coalesces with the execute token 1546ms
   ✓ custom wrapper execution bounds are reader-owned > still bounds an un-terminated handshake buffer and names the bound 488ms
   ✓ delivers the journaled memory pack to the real wrapper and excludes its charge from completion usage 582ms
 ✓ tests/flow-extension-compose.test.ts (33 tests) 6932ms
   ✓ composing flow extensions onto a base flow > composes two extensions in declaration order, and the order is the lockfile order 497ms
   ✓ composing flow extensions onto a base flow > flows check reports the composition and keeps the composed triggers deliverable 1137ms
   ✓ composing flow extensions onto a base flow > flows check probes extension preflight before reporting the project healthy 338ms
   ✓ composing flow extensions onto a base flow > uses extension permissions for hosted deploy preflight and the deploy body 389ms
 ✓ tests/cloud-run.test.ts (69 tests) 872ms
(node:14440) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
 ✓ tests/cli-status.test.ts (27 tests) 1438ms
   ✓ flows status > resolves the run with no arguments from inside a worker-spawned agent 1189ms
 ✓ tests/run-state.test.ts (28 tests) 12ms
 ✓ tests/relay-cli-surface.test.ts (88 tests) 42ms
 ✓ tests/agent-transcript.test.ts (29 tests) 277ms
 ✓ tests/babysitter-native-extension.test.ts (41 tests | 1 skipped) 1706ms
   ✓ native Babysitter extension > binds the pinned artifact to the actual base and complete installed route set 356ms
 ✓ tests/shipped-source-model-provenance.test.ts (1 test) 121518ms
   ✓ shipped-source model provenance > does not treat mutable aliases or incomplete named agents as pinned 121517ms
(node:14642) [FLOWS_ROOT_LEASE_LOST] Warning: authored root run_id=root-run attempt=1: lease_conflict: attempt has no active worker lease. Waiting for the kernel to retry it.
(Use `node --trace-warnings ...` to show where the warning was created)
 ✓ tests/authored-root.test.ts (22 tests) 398ms
 ✓ tests/authored-completion-detail.test.ts (59 tests) 150ms
 ✓ tests/shipped-source-worker-call-forms.test.ts (1 test) 17413ms
   ✓ shipped-source worker call forms > fails closed for computed keys, assertions, binds, call, and apply 17412ms
 ✓ tests/step-failure-diagnostic.test.ts (26 tests) 75ms
 ✓ tests/stop-process-group.test.ts (11 tests) 15362ms
   ✓ every stop reaches the process group, not just the direct child > exits the run after an execution-timeout stop 1057ms
   ✓ every stop reaches the process group, not just the direct child > exits the run after a protocol terminate stop 598ms
   ✓ every stop reaches the process group, not just the direct child > kills a SIGTERM-deaf grandchild after a protocol terminate stop 1679ms
   ✓ every stop reaches the process group, not just the direct child > kills a SIGTERM-deaf grandchild after an execution-timeout stop 2184ms
   ✓ every stop reaches the process group, not just the direct child > holds the loop open long enough for the escalation to run 1112ms
   ✓ every stop reaches the process group, not just the direct child > bounds forced-stop confirmation when a group remains unprovable 1014ms
   ✓ a wrapper that exits with no execution deadline still drains > reports the wrapper result and reaps a grandchild holding its pipes 1018ms
   ✓ a wrapper that exits with no execution deadline still drains > reaps a SIGTERM-deaf grandchild holding its pipes 1908ms
   ✓ a wrapper that exits with no execution deadline still drains > settles on its own deadline when an escaped holder withholds close 4457ms
 ❯ tests/mcp.test.ts (34 tests | 4 skipped) 15877ms
   ✓ MCP preflight and transports > flows check refuses an undeclared server with exit 2 and no daemon 922ms
   ✓ MCP preflight and transports > flows check reports a refusing server and leaves no PID 948ms
   ✓ MCP preflight and transports > kills a SIGTERM-resistant silent child after a parent-owned handshake deadline 1312ms
   ✓ MCP preflight and transports > reaps a SIGTERM-resistant descendant with inherit stdio before cleanup finishes 1063ms
   ✓ MCP preflight and transports > reaps a SIGTERM-resistant descendant with ignore stdio before cleanup finishes 2022ms
   ✓ MCP preflight and transports > rejects close when forced group death remains unprovable 2065ms
   ✓ MCP preflight and transports > cancels force escalation when close follows an exited child 1182ms
   ✓ MCP preflight and transports > waits for child close when the transport cannot own a process group 1058ms
   ✓ MCP preflight and transports > cancels force escalation for an already-closed child without a process group 1176ms
   ✓ MCP preflight and transports > reports malformed connection configuration as config_invalid 1081ms
 ✓ tests/step-attempt-history.test.ts (23 tests) 22ms
 ✓ tests/daemon-lifecycle.test.ts (42 tests) 39ms
```

</details>
