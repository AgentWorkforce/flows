The CLI renderer already implemented head/tail excerpts and failure highlighting at a 4,096-byte budget. The remaining loss happened earlier: agent digests cut to a plain head or tail, and deterministic capture discarded everything before the last 64 KiB. This change preserves early evidence through those layers.

```text
$ rg -n 'last 1,024|last 1024' packages/sdk/src kernel --glob '*.ts' --glob '*.rs'
packages/sdk/src/cli/step-excerpt.ts:5: * The render this replaces kept the last 1,024 bytes. For any runner that
```

- Agent `result`, `tool_result`, and `stderr` failure excerpts now select head, failure lines, and tail within 1,024 UTF-8 bytes, after redaction. Decoder refusals use the same selection. `truncated` remains explicit.
- Go per-test failures and Jest case headings are highlighted. Go package summaries already matched; Jest's `● Console` section is excluded.
- Deterministic capture retains a quarter-budget head and the remaining tail within 64 KiB, including a distinct `relayflow: N bytes elided at capture` marker. The renderer reserves space for capture provenance without counting it as a test failure.
- Duplicate deterministic `trajectory_tail` evidence is bounded to 16 KiB including JSON framing and escaping. The larger `output` evidence remains available.

Implemented as four phase commits on the existing branch: `d174a96`, `dc3d4a1`, `a3fd013`, `0bcab38`. Follow-up `b478374` protects a leading capture marker that crosses the head boundary. No workflow files changed.

Compatibility and limits:

- Valid UTF-8 command output at or below 64 KiB remains unchanged. Larger output already underwent truncation; its retained bytes now change. Invalid UTF-8 still uses lossy decoding, but its expanded representation also respects the budget.
- Agent result/tool-result excerpts now pass through the display sanitiser, which replaces control characters (including ESC) with `?`. This changes journaled display bytes, including coloured prose; existing live fixtures are included in verification.
- Capture does not recognise test-runner vocabulary. Failures inside the discarded middle of a large stream remain unavailable; the new marker makes that loss explicit. Rendering can only highlight retained evidence.
- `read_all` still buffers the entire stream. Follow-up: implement a bounded reader with fixed head storage, a rolling tail, and a total-byte counter. The current budget limits retention, not peak memory.
- Configurable budgets are deferred: an environment switch would introduce ambient configuration; a per-step field should wait for demonstrated need. Out-of-band byte counts are also deferred.
- Restoring `flows replay` after CI requires artifact retention in the workflows running those campaigns, outside this change. Live `--tails` and the kernel's worker-detail head cut are unchanged.
- A stream one byte over budget must omit more than one byte to fit an in-band marker. The regression asserts exact accounting including that marker space, correcting the original plan's impossible one-byte expectation.

Verification evidence below contains literal commands and captured output. Expected regression failures and intermediate failures are retained separately, with no claim that those runs passed:

| Phase | Before / reverted | Restored |
| --- | --- | --- |
| A: all digest failure paths | [before](docs/evidence/failure-capture/a-before.txt), [reverted](docs/evidence/failure-capture/a-reverted.txt) | [restored](docs/evidence/failure-capture/a-restored.txt) |
| B: Go/Jest markers | [before](docs/evidence/failure-capture/b-before.txt), [reverted](docs/evidence/failure-capture/b-reverted.txt) | [restored](docs/evidence/failure-capture/b-restored.txt) |
| C: renderer provenance | [before](docs/evidence/failure-capture/c-sdk-before.txt), [reverted](docs/evidence/failure-capture/c-sdk-reverted.txt) | [restored](docs/evidence/failure-capture/c-sdk-restored.txt) |
| C: kernel capture | [executor before](docs/evidence/failure-capture/c-kernel-before.txt), [capture reverted](docs/evidence/failure-capture/c-capture-reverted.txt) | [executor after](docs/evidence/failure-capture/c-kernel-after.txt), [capture restored](docs/evidence/failure-capture/c-capture-restored.txt) |
| C follow-up: marker crossing head | [before](docs/evidence/failure-capture/c-head-before.txt), [reverted](docs/evidence/failure-capture/c-head-reverted.txt) | [restored](docs/evidence/failure-capture/c-head-restored.txt) |
| D: duplicate trajectory | [before](docs/evidence/failure-capture/d-before.txt), [reverted](docs/evidence/failure-capture/d-reverted.txt) | [restored](docs/evidence/failure-capture/d-restored.txt) |

A/B/C-renderer mutations restored the previous production code while retaining the new tests. C-capture replaced the helper body with the prior tail-only algorithm. D restored the prior executor implementation while retaining the new tests. Each reverted implementation was saved and restored byte-for-byte before its restored run.

The initial [live-fixture run](docs/evidence/failure-capture/a-after.txt) failed because the daemon binary was absent. Building it resolved that prerequisite. An intermediate [256-byte renderer run](docs/evidence/failure-capture/c-sdk-after.txt) exposed marker truncation; structural markers now receive their space first. The focused run below includes both fixes. The subsequent leading-marker boundary regression has its own restored run, and the final full-suite run includes that follow-up.

The first [full-suite run](docs/evidence/failure-capture/sdk-full.txt) lacked an explicit daemon path and failed (19 failed, 2757 passed, 25 skipped; one unhandled missing-binary error). The final run sets `RELAYFLOWD_BIN` to the built binary. The final run reports 8 failed, 2777 passed, and 17 skipped tests, with two failed files: eight live-kernel cases and an authored-node-runtime suite setup asserting daemon version `1.4.0` instead of the binary's `1.3.6`. These are compared below with the original `5546c4b` in an isolated worktree, using a separately built baseline daemon and SDK. [Baseline identity](docs/evidence/failure-capture/baseline-identity.txt) records the commit and absence of tracked changes. No analyzer-skip override or test-gate changes were used.

Baseline setup (build outputs: [SDK](docs/evidence/failure-capture/baseline-sdk-build.txt), [kernel](docs/evidence/failure-capture/baseline-kernel-build.txt)):

```sh
git worktree add --detach /tmp/relayflow-capture-baseline d174a96^
ln -s /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk/node_modules /tmp/relayflow-capture-baseline/packages/sdk/node_modules
git worktree move /tmp/relayflow-capture-baseline /home/daytona/.relayflow-v2-supervisor/durable/capture-baseline
```

The first baseline run in `/tmp` had only one analyzer failure ([output](docs/evidence/failure-capture/baseline-live-kernel.txt)). Moving the same worktree under the checkout's parent reproduced the extensionless fixture's empty identification output; that parent has a CommonJS package scope. The matched-location baseline run below reproduces the same eight failing test names and the same daemon-version suite setup failure. This is an environment-sensitive baseline limitation, not a green full-suite claim.

<details>
<summary>prep: literal command and captured output</summary>

```text
$ npm install --prefix packages/sdk --no-audit --no-fund

> @relayflows/sdk@2.0.28 prepare
> npm run build


> @relayflows/sdk@2.0.28 build
> tsc && node scripts/make-cli-executable.mjs


changed 1 package in 5s

```

</details>

<details>
<summary>kernel-build: literal command and captured output</summary>

```text
$ cd kernel && sh ../ops/cargo.sh build -p relayflowd
 Downloading crates ...
  Downloaded ahash v0.8.12
  Downloaded anyhow v1.0.104
  Downloaded aho-corasick v1.1.5
  Downloaded fallible-streaming-iterator v0.1.9
  Downloaded generic-array v0.14.7
  Downloaded getrandom v0.3.4
  Downloaded foldhash v0.1.5
  Downloaded fraction v0.15.4
  Downloaded find-msvc-tools v0.1.11
  Downloaded utf8_iter v1.0.4
  Downloaded uuid v1.26.0
  Downloaded uuid-simd v0.8.0
  Downloaded utf8parse v0.2.2
  Downloaded zerofrom-derive v0.1.7
  Downloaded lock_api v0.4.14
  Downloaded parking_lot v0.12.5
  Downloaded version_check v0.9.5
  Downloaded wait-timeout v0.2.1
  Downloaded zerofrom v0.1.8
  Downloaded rand_core v0.9.5
  Downloaded base64 v0.22.1
  Downloaded serde v1.0.229
  Downloaded yoke-derive v0.8.2
  Downloaded displaydoc v0.2.7
  Downloaded vsimd v0.8.0
  Downloaded autocfg v1.5.1
  Downloaded ref-cast v1.0.27
  Downloaded zerovec-derive v0.11.6
  Downloaded writeable v0.6.4
  Downloaded yoke v0.8.3
  Downloaded zmij v1.0.23
  Downloaded num-iter v0.1.46
  Downloaded ppv-lite86 v0.2.21
  Downloaded proc-macro2 v1.0.107
  Downloaded serde_derive v1.0.229
  Downloaded zerotrie v0.2.5
  Downloaded zerovec v0.11.8
  Downloaded bit-vec v0.8.0
  Downloaded itoa v1.0.18
  Downloaded vcpkg v0.2.15
  Downloaded zerocopy v0.8.56
  Downloaded is_terminal_polyfill v1.70.2
  Downloaded lazy_static v1.5.0
  Downloaded block-buffer v0.10.4
  Downloaded strsim v0.11.1
  Downloaded bytecount v0.6.9
  Downloaded colorchoice v1.0.5
  Downloaded idna_adapter v1.2.2
  Downloaded scopeguard v1.2.0
  Downloaded heck v0.5.0
  Downloaded quote v1.0.47
  Downloaded tinystr v0.8.4
  Downloaded bit-set v0.8.0
  Downloaded num-integer v0.1.47
  Downloaded percent-encoding v2.3.2
  Downloaded pkg-config v0.3.34
  Downloaded thiserror v2.0.20
  Downloaded sha2 v0.10.9
  Downloaded thiserror-impl v2.0.20
  Downloaded ulid v1.2.1
  Downloaded parking_lot_core v0.9.12
  Downloaded digest v0.10.7
  Downloaded smallvec v1.15.2
  Downloaded num-rational v0.4.2
  Downloaded fallible-iterator v0.3.0
  Downloaded num v0.4.3
  Downloaded once_cell v1.21.4
  Downloaded icu_provider v2.3.1
  Downloaded clap v4.6.6
  Downloaded stable_deref_trait v1.2.1
  Downloaded outref v0.5.2
  Downloaded anstyle v1.0.14
  Downloaded anstyle-parse v1.0.0
  Downloaded potential_utf v0.1.6
  Downloaded cpufeatures v0.2.17
  Downloaded num-traits v0.2.19
  Downloaded clap_derive v4.6.4
  Downloaded serde_core v1.0.229
  Downloaded fluent-uri v0.3.2
  Downloaded num-complex v0.4.6
  Downloaded rand_chacha v0.9.0
  Downloaded cfg-if v1.0.4
  Downloaded ref-cast-impl v1.0.27
  Downloaded icu_locale_core v2.3.0
  Downloaded icu_collections v2.3.0
  Downloaded shlex v2.0.1
  Downloaded email_address v0.2.9
  Downloaded num-cmp v0.1.0
  Downloaded rusqlite v0.37.0
  Downloaded synstructure v0.13.2
  Downloaded unicode-ident v1.0.24
  Downloaded hashlink v0.10.0
  Downloaded litemap v0.8.3
  Downloaded referencing v0.33.0
  Downloaded num-bigint v0.4.8
  Downloaded icu_properties v2.3.0
  Downloaded memchr v2.8.3
  Downloaded fancy-regex v0.16.2
  Downloaded hashbrown v0.15.5
  Downloaded bitflags v2.13.1
  Downloaded jsonschema v0.33.0
  Downloaded ryu-js v1.0.3
  Downloaded icu_normalizer_data v2.3.0
  Downloaded idna v1.1.0
  Downloaded rand v0.9.5
  Downloaded typenum v1.20.1
  Downloaded cc v1.4.4
  Downloaded clap_builder v4.6.6
  Downloaded icu_properties_data v2.3.0
  Downloaded regex v1.13.1
  Downloaded serde_json v1.0.151
  Downloaded syn v3.0.4
  Downloaded syn v2.0.119
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
   Compiling autocfg v1.5.1
   Compiling cfg-if v1.0.4
   Compiling serde_core v1.0.229
   Compiling num-traits v0.2.19
   Compiling getrandom v0.3.4
   Compiling zerocopy v0.8.56
   Compiling syn v3.0.4
   Compiling syn v2.0.119
   Compiling serde v1.0.229
   Compiling smallvec v1.15.2
   Compiling synstructure v0.13.2
   Compiling zerofrom-derive v0.1.7
   Compiling yoke-derive v0.8.2
   Compiling zerofrom v0.1.8
   Compiling yoke v0.8.3
   Compiling memchr v2.8.3
   Compiling litemap v0.8.3
   Compiling writeable v0.6.4
   Compiling num-integer v0.1.47
   Compiling zerovec-derive v0.11.6
   Compiling displaydoc v0.2.7
   Compiling serde_derive v1.0.229
   Compiling generic-array v0.14.7
   Compiling icu_normalizer_data v2.3.0
   Compiling utf8_iter v1.0.4
   Compiling icu_properties_data v2.3.0
   Compiling zmij v1.0.23
   Compiling zerotrie v0.2.5
   Compiling ref-cast v1.0.27
   Compiling zerovec v0.11.8
   Compiling parking_lot_core v0.9.12
   Compiling typenum v1.20.1
   Compiling num-bigint v0.4.8
   Compiling tinystr v0.8.4
   Compiling icu_locale_core v2.3.0
   Compiling potential_utf v0.1.6
   Compiling icu_collections v2.3.0
   Compiling icu_provider v2.3.1
   Compiling ref-cast-impl v1.0.27
   Compiling aho-corasick v1.1.5
   Compiling ahash v0.8.12
   Compiling serde_json v1.0.151
   Compiling regex-syntax v0.8.11
   Compiling find-msvc-tools v0.1.11
   Compiling scopeguard v1.2.0
   Compiling shlex v2.0.1
   Compiling cc v1.4.4
   Compiling lock_api v0.4.14
   Compiling icu_normalizer v2.3.0
   Compiling icu_properties v2.3.0
   Compiling regex-automata v0.4.18
   Compiling num-rational v0.4.2
   Compiling num-iter v0.1.46
   Compiling ppv-lite86 v0.2.21
   Compiling rand_core v0.9.5
   Compiling num-complex v0.4.6
   Compiling pkg-config v0.3.34
   Compiling borrow-or-share v0.2.4
   Compiling vcpkg v0.2.15
   Compiling itoa v1.0.18
   Compiling bit-vec v0.8.0
   Compiling once_cell v1.21.4
   Compiling bit-set v0.8.0
   Compiling libsqlite3-sys v0.35.0
   Compiling num v0.4.3
   Compiling fluent-uri v0.3.2
   Compiling rand_chacha v0.9.0
   Compiling parking_lot v0.12.5
   Compiling idna_adapter v1.2.2
   Compiling block-buffer v0.10.4
   Compiling crypto-common v0.1.7
   Compiling thiserror v2.0.20
   Compiling lazy_static v1.5.0
   Compiling utf8parse v0.2.2
   Compiling uuid v1.26.0
   Compiling outref v0.5.2
   Compiling vsimd v0.8.0
   Compiling percent-encoding v2.3.2
   Compiling foldhash v0.1.5
   Compiling referencing v0.33.0
   Compiling hashbrown v0.15.5
   Compiling uuid-simd v0.8.0
   Compiling anstyle-parse v1.0.0
   Compiling fraction v0.15.4
   Compiling digest v0.10.7
   Compiling idna v1.1.0
   Compiling regex v1.13.1
   Compiling fancy-regex v0.16.2
   Compiling rand v0.9.5
   Compiling email_address v0.2.9
   Compiling thiserror-impl v2.0.20
   Compiling base64 v0.22.1
   Compiling colorchoice v1.0.5
   Compiling anstyle v1.0.14
   Compiling anstyle-query v1.1.5
   Compiling is_terminal_polyfill v1.70.2
   Compiling num-cmp v0.1.0
   Compiling cpufeatures v0.2.17
   Compiling bytecount v0.6.9
   Compiling sha2 v0.10.9
   Compiling jsonschema v0.33.0
   Compiling anstream v1.0.0
   Compiling ulid v1.2.1
   Compiling hashlink v0.10.0
   Compiling ryu-js v1.0.3
   Compiling heck v0.5.0
   Compiling fallible-streaming-iterator v0.1.9
   Compiling bitflags v2.13.1
   Compiling strsim v0.11.1
   Compiling anyhow v1.0.104
   Compiling clap_lex v1.1.0
   Compiling fallible-iterator v0.3.0
   Compiling clap_builder v4.6.6
   Compiling clap_derive v4.6.4
   Compiling relayflowd-core v0.1.0 (/home/daytona/.relayflow-v2-supervisor/durable/repository/kernel/relayflowd-core)
   Compiling clap v4.6.6
   Compiling wait-timeout v0.2.1
   Compiling rusqlite v0.37.0
   Compiling relayflowd-journal v0.1.0 (/home/daytona/.relayflow-v2-supervisor/durable/repository/kernel/relayflowd-journal)
   Compiling relayflowd v0.1.0 (/home/daytona/.relayflow-v2-supervisor/durable/repository/kernel/relayflowd)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 18.87s

```

</details>

<details>
<summary>sdk-final-build: literal command and captured output</summary>

```text
$ cd packages/sdk && npm run build

> @relayflows/sdk@2.0.28 build
> tsc && node scripts/make-cli-executable.mjs


```

</details>

<details>
<summary>typecheck-final: literal command and captured output</summary>

```text
$ cd packages/sdk && npm run typecheck

> @relayflows/sdk@2.0.28 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json


```

</details>

<details>
<summary>typecheck-tests: literal command and captured output</summary>

```text
$ cd packages/sdk && npm run typecheck:tests

> @relayflows/sdk@2.0.28 typecheck:tests
> tsc -p tsconfig.tests.json


```

</details>

<details>
<summary>sdk-focused: literal command and captured output</summary>

```text
$ cd packages/sdk && npx vitest run tests/step-failure-excerpt.test.ts tests/agent-transcript.test.ts tests/agent-transcript-live.test.ts tests/step-failure-diagnostic.test.ts tests/authored-node-result.test.ts tests/failure-capture-digest.test.ts

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ✓ tests/step-failure-excerpt.test.ts (49 tests) 346ms
 ✓ tests/agent-transcript.test.ts (29 tests) 323ms
 ✓ tests/authored-node-result.test.ts (39 tests) 16ms
 ✓ tests/step-failure-diagnostic.test.ts (25 tests) 68ms
 ✓ tests/failure-capture-digest.test.ts (7 tests) 80ms
 ✓ tests/agent-transcript-live.test.ts (4 tests) 43210ms
   ✓ the transcript digest through the built CLI, a real daemon and the local agent > preserves structured agent failure details and its completed root index 13673ms
   ✓ the transcript digest through the built CLI, a real daemon and the local agent > preserves structured llm failure details and its completed root index 15308ms
   ✓ the transcript digest through the built CLI, a real daemon and the local agent > journals the digest in trajectory_tail on a successful agent step and writes the file it points at 991ms
   ✓ the transcript digest through the built CLI, a real daemon and the local agent > on a failed agent step, names the failure and the transcript in the terminal diagnostic, redacted 13238ms

 Test Files  6 passed (6)
      Tests  153 passed (153)
   Start at  00:00:08
   Duration  44.18s (transform 1.03s, setup 0ms, collect 2.30s, tests 44.04s, environment 1ms, prepare 319ms)


```

</details>

<details>
<summary>c-head-restored: literal command and captured output</summary>

```text
$ cd packages/sdk && npx vitest run tests/step-failure-excerpt.test.ts

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ✓ tests/step-failure-excerpt.test.ts (50 tests) 276ms

 Test Files  1 passed (1)
      Tests  50 passed (50)
   Start at  00:03:43
   Duration  536ms (transform 64ms, setup 0ms, collect 65ms, tests 276ms, environment 0ms, prepare 69ms)


Exit code: 0

```

</details>

<details>
<summary>sdk-full-final: literal command and captured output</summary>

```text
$ cd packages/sdk && RELAYFLOWD_BIN=/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd npx vitest run

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

stdout | tests/live-kernel.test.ts
LIVE_KERNEL relayflowd=/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd
LIVE_KERNEL flows=/home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk/dist/cli.js

 ✓ tests/preflight.test.ts (67 tests) 93ms
 ✓ tests/cloud-read.test.ts (41 tests) 39ms
 ✓ tests/cli.test.ts (70 tests) 1990ms
   ✓ flows check CLI > binds a checked relative wrapper to the flow directory for worker execution 411ms
   ✓ flows check CLI > resolves a bare PATH-resolved claude with no declared model, in an isolated PATH 406ms
 ✓ tests/cloud-sync.test.ts (40 tests) 1040ms
 ✓ tests/cloud-transcript-codex.test.ts (39 tests) 30ms
 ✓ tests/plugin-extension.test.ts (90 tests) 573ms
 ✓ tests/observer-link.test.ts (39 tests) 154ms
 ✓ tests/agent-transcript.test.ts (29 tests) 300ms
 ✓ tests/authored-flow.test.ts (34 tests) 775ms
 ✓ tests/cloud-run.test.ts (58 tests) 821ms
(node:46177) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
 ✓ tests/cli-status.test.ts (26 tests) 901ms
   ✓ flows status > resolves the run with no arguments from inside a worker-spawned agent 655ms
 ✓ tests/relay-cli-surface.test.ts (75 tests) 28ms
 ✓ tests/step-failure-diagnostic.test.ts (25 tests) 65ms
 ✓ tests/daemon-lifecycle.test.ts (42 tests) 38ms
 ✓ tests/stop-process-group.test.ts (9 tests) 13060ms
   ✓ every stop reaches the process group, not just the direct child > exits the run after an execution-timeout stop 840ms
   ✓ every stop reaches the process group, not just the direct child > exits the run after a protocol terminate stop 462ms
   ✓ every stop reaches the process group, not just the direct child > kills a SIGTERM-deaf grandchild after a protocol terminate stop 1651ms
   ✓ every stop reaches the process group, not just the direct child > kills a SIGTERM-deaf grandchild after an execution-timeout stop 2050ms
   ✓ every stop reaches the process group, not just the direct child > holds the loop open long enough for the escalation to run 1084ms
   ✓ a wrapper that exits with no execution deadline still drains > reports the wrapper result and reaps a grandchild holding its pipes 752ms
   ✓ a wrapper that exits with no execution deadline still drains > reaps a SIGTERM-deaf grandchild holding its pipes 1706ms
   ✓ a wrapper that exits with no execution deadline still drains > settles on its own deadline when an escaped holder withholds close 4255ms
 ✓ tests/run-state.test.ts (21 tests) 10ms
 ✓ tests/cloud-deploy.test.ts (40 tests) 1362ms
 ✓ tests/flow-extension-compose.test.ts (22 tests) 4177ms
   ✓ composing flow extensions onto a base flow > composes two extensions in declaration order, and the order is the lockfile order 476ms
   ✓ composing flow extensions onto a base flow > flows check reports the composition and keeps the composed triggers deliverable 788ms
 ✓ tests/worker-cli.test.ts (18 tests) 25776ms
   ✓ registered CLI model defaults > passes the same priced Claude default to the real provider invocation 380ms
   ✓ step discovery environment > names the run, step, attempt and an absolute data dir for a direct agent spawn 310ms
   ✓ step discovery environment > exports none of the four without a data dir, even when the worker inherited them 426ms
   ✓ wrapper discovery environment > sets the four names from the dispatch and still refuses ambient values and other secrets 381ms
   ✓ wrapper discovery environment > exports none of the four to a wrapper without a data dir, even when the worker inherited them 365ms
   ✓ custom wrapper execution identity > passes an explicit safe environment at identification and execution 416ms
   ✓ custom wrapper execution identity > refuses a wrapper symlink retarget before delivering private values 357ms
   ✓ custom wrapper execution identity > bounds wrapper execution after acknowledgement 438ms
   ✓ custom wrapper execution identity > bounds captured wrapper output 433ms
   ✓ custom wrapper execution identity > refuses a duplicate execute protocol frame 375ms
   ✓ custom wrapper execution bounds are reader-owned > resolves when a conforming wrapper leaks a stdio pipe to a background helper 1962ms
   ✓ custom wrapper execution bounds are reader-owned > resolves when the leaked helper inherits stderr only 1984ms
   ✓ custom wrapper execution bounds are reader-owned > resolves when a wrapper leaks a stdio pipe and exits before identifying 3665ms
   ✓ custom wrapper execution bounds are reader-owned > journals a completionReason at the default bound when a wrapper leaks a stdio pipe 11711ms
   ✓ custom wrapper execution bounds are reader-owned > accepts an execute token and an over-8KiB payload flushed in one write 422ms
   ✓ custom wrapper execution bounds are reader-owned > accepts the same over-8KiB payload whether or not it coalesces with the execute token 1240ms
   ✓ custom wrapper execution bounds are reader-owned > still bounds an un-terminated handshake buffer and names the bound 444ms
   ✓ delivers the journaled memory pack to the real wrapper and excludes its charge from completion usage 466ms
 ✓ tests/journal-client.test.ts (17 tests) 79ms
 ✓ tests/authored-root.test.ts (13 tests) 171ms
 ✓ tests/cloud-connect.test.ts (24 tests) 3088ms
   ✓ hosted verbs connect before they submit > flows run --cloud submits once the prompt connected the integration 2135ms
 ❯ tests/authored-node-runtime.test.ts (14 tests | 14 skipped) 12ms
 ✓ tests/close-pr-flow.test.ts (28 tests) 369ms
 ✓ tests/bundle.test.ts (26 tests) 8285ms
   ✓ immutable bundles > returns exit 2 naming a byte-flipped payload and refuses to reuse corruption 365ms
   ✓ immutable bundles > verifies with --verify in any position and answers --json with one object 709ms
   ✓ immutable bundles > refuses --out with --verify rather than ignoring the destination 357ms
   ✓ immutable bundles > builds and verifies the canonical YAML fixture through the compiled CLI 1086ms
   ✓ immutable bundles > emits the ephemeral warning on CLI stderr and uses the default output directory 734ms
   ✓ immutable bundles > refuses build-provable CLI resolution errors without environment probes 365ms
   ✓ immutable bundles > builds a standalone TS fixture twice with identical executable hashes 2345ms
   ✓ immutable bundles > refuses to label installed dependency drift with lockfile pins 364ms
   ✓ immutable bundles > refuses invalid CLI arguments %j 355ms
   ✓ immutable bundles > refuses invalid CLI arguments "--out" 349ms
   ✓ immutable bundles > refuses invalid CLI arguments "--verify" 363ms
   ✓ immutable bundles > refuses invalid CLI arguments "--verify" 362ms
   ✓ immutable bundles > refuses invalid CLI arguments "--out" 370ms
 ✓ tests/validate.test.ts (68 tests) 22ms
 ✓ tests/verb-field-lint.test.ts (96 tests) 290ms
stdout | tests/live-kernel.test.ts > surface resume after a real daemon kill > resumes a three-step run with each successful completion exactly once
LIVE_KERNEL kill -9 pid=48598 run=01M35S95ZK9T56706DVNVHFE1M while step=two state=Running

 ✓ tests/mcp.test.ts (30 tests) 21219ms
   ✓ MCP preflight and transports > flows check refuses an undeclared server with exit 2 and no daemon 570ms
   ✓ MCP preflight and transports > flows check reports a refusing server and leaves no PID 658ms
   ✓ MCP preflight and transports > kills a SIGTERM-resistant silent child after a parent-owned handshake deadline 1323ms
   ✓ MCP preflight and transports > reaps a SIGTERM-resistant descendant with inherit stdio before cleanup finishes 1127ms
   ✓ MCP preflight and transports > reaps a SIGTERM-resistant descendant with ignore stdio before cleanup finishes 2070ms
   ✓ MCP preflight and transports > reports malformed connection configuration as config_invalid 614ms
   ✓ authored MCP effects against the real kernel > reports a dropped tool connection as a failed CLI run 13856ms
 ✓ tests/step-failure-excerpt.test.ts (50 tests) 281ms
 ✓ tests/tick-source.test.ts (33 tests) 25ms
 ❯ tests/live-kernel.test.ts (31 tests | 8 failed) 54757ms
   ✓ built flows CLI against live relayflowd > twenty-six-step reuses 25 durable completions after editing the failed final step 2427ms
   ✓ built flows CLI against live relayflowd > runs rung (a), parks rung (b), and keeps JSON report-shaped 2937ms
   ✓ built flows CLI against live relayflowd > allows a deterministic run to exceed the bounded request timeout 32583ms
   ✓ built flows CLI against live relayflowd > follows a live worker dispatch through flows run 585ms
   ✓ built flows CLI against live relayflowd > runs an agent CLI end to end through the SDK worker 541ms
   ✓ built flows CLI against live relayflowd > f.agent lowers to a real agent step and dispatches through a live worker 663ms
   ✓ built flows CLI against live relayflowd > can always get a parked run to a late-attaching worker 5580ms
   ✓ built flows CLI against live relayflowd > reports a real manual-recovery NeedsHuman state as parked 509ms
   × built flows CLI against live relayflowd > runs hn-monitor analyze-story end-to-end via a stub agent CLI (gate 2 clause 2 demo) 475ms
     → expected { …(12) } to match object { output: { …(3) }, …(1) }
(22 matching properties omitted from actual)
   × built flows CLI against live relayflowd > hn-monitor analyze-story FAILS verification when the CLI omits required schema fields 553ms
     → expected { …(12) } to match object { …(3) }
(21 matching properties omitted from actual)
   × built flows CLI against live relayflowd > agent step preserves the CliResult wrapper as output when the CLI emits non-JSON text 476ms
     → expected null not to be null
   × built flows CLI against live relayflowd > AgentWorker exposes wake_context to the CLI via RELAYFLOW_WAKE_CONTEXT env var (real analyzer prerequisite) 515ms
     → Cannot read properties of null (reading 'story_title')
   × built flows CLI against live relayflowd > AgentWorker leaves RELAYFLOW_WAKE_CONTEXT UNSET when the run has no wake_context (undefined-vs-null pin) 415ms
     → Cannot read properties of null (reading 'env_present')
   ✓ built flows CLI against live relayflowd > AgentWorker passes a declared model to an identified wrapper as RELAYFLOW_MODEL 472ms
   ✓ built flows CLI against live relayflowd > AgentWorker refuses a nonconforming journal-submitted wrapper before exposing RELAYFLOW_MODEL 430ms
   ✓ built flows CLI against live relayflowd > AgentWorker executes the raw claude adapter with its real model flag 545ms
   ✓ built flows CLI against live relayflowd > AgentWorker executes the raw codex adapter with its real model flag 592ms
   × built flows CLI against live relayflowd > AgentWorker leaves RELAYFLOW_MODEL UNSET when the step declares no model 688ms
     → Cannot read properties of null (reading 'story_title')
   × built flows CLI against live relayflowd > hn-monitor analyze-story reaches done through the real Claude analyzer CLI 41ms
     → LIVE_ANALYZER_UNAVAILABLE: "/home/daytona/.relayflow-v2-supervisor/durable/repository/testdata/preflight/analyze-story-claude-cli" does not identify as relayflows-agent-cli-v1 — failing because gate-2 acceptance requires the real analyzer to execute. Set RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 only if this run is not gate evidence.
   ✓ built flows CLI against live relayflowd > preflights before journaling and names an unreachable socket 820ms
   ✓ built flows CLI against live relayflowd > starts exactly one daemon when two runs race for one empty data dir 546ms
   ✓ surface resume after a real daemon kill > resumes a three-step run with each successful completion exactly once 1029ms
   × a relayflow can be scheduled: tick source against live relayflowd > a tick spawns a real run whose step reports the SCHEDULED instant 549ms
     → expected null to deeply equal { schedule_id: 'heartbeat-1m', …(3) }
 ✓ tests/flow-executor-chain.test.ts (14 tests) 11143ms
   ✓ flow executor LLM and output-binding chain > runs f.llm -> f.agent -> f.run with schema-verified journal output and the exact allowed model 854ms
   ✓ flow executor LLM and output-binding chain > runs a dollar-budgeted authored Claude agent with the same default used by preflight 630ms
   ✓ flow executor LLM and output-binding chain > fails invalid LLM output before the next step: not JSON 310ms
   ✓ flow executor LLM and output-binding chain > fails invalid LLM output before the next step: {"message":7} 326ms
   ✓ flow executor LLM and output-binding chain > preserves JSON values without promoting them to process wrappers: null 367ms
   ✓ flow executor LLM and output-binding chain > preserves JSON values without promoting them to process wrappers: [1,2] 386ms
   ✓ flow executor LLM and output-binding chain > preserves JSON values without promoting them to process wrappers: "hello" 372ms
   ✓ flow executor LLM and output-binding chain > runs the exact authored flagship f.llm -> f.agent -> f.run path through the durable CLI root 1755ms
   ✓ flow executor LLM and output-binding chain > resumes an interrupted durable authored root without replaying completed flagship effects 3711ms
   ✓ flow executor LLM and output-binding chain > passes a declarative verified value through an agent into a deterministic artifact 778ms
   ✓ flow executor LLM and output-binding chain > flows run consumes YAML bindings and resume reuses the original journal output 1133ms
 ✓ tests/authored-step-graph.test.ts (25 tests) 1116ms
   ✓ the authored step DAG > does not walk a long-running step's own polling chain to find its dependents' edges 497ms
   ✓ the authored step DAG > does not walk a long-running step's chain when a wrapper awaits it 312ms
 ✓ tests/authored-flow-lifecycle-executor.test.ts (27 tests) 605ms
 ✓ tests/agent-relay-transport.test.ts (16 tests) 2274ms
   ✓ Relay completion at the journal boundary > does not complete at readiness and journals exact output, receipt, and priced accounting 1011ms
   ✓ Relay completion at the journal boundary > aborts polling on rejected renewal and never writes a stale completion 1003ms
 ✓ tests/pr-review-post.test.ts (21 tests) 2319ms
 ✓ tests/authored-flow-slack.test.ts (7 tests) 1879ms
   ✓ authored Slack helper effects > replays after SIGKILL before confirm with the same token and one successful completion 545ms
   ✓ authored Slack helper effects > replays after SIGKILL before complete with the same token and one successful completion 533ms
   ✓ authored Slack helper effects > writes two files for two calls and supports dm, reply, and react 380ms
(node:49428) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
 ✓ tests/tick-runner.test.ts (22 tests) 2151ms
   ✓ CLI argument parsing refuses coercion rather than accepting it > refuses --interval-ms fractional as an invocation error 354ms
   ✓ CLI argument parsing refuses coercion rather than accepting it > refuses --interval-ms exponent notation as an invocation error 348ms
   ✓ CLI argument parsing refuses coercion rather than accepting it > refuses --interval-ms hex as an invocation error 353ms
   ✓ CLI argument parsing refuses coercion rather than accepting it > refuses --interval-ms trailing text as an invocation error 362ms
   ✓ CLI argument parsing refuses coercion rather than accepting it > refuses --interval-ms empty as an invocation error 364ms
   ✓ CLI argument parsing refuses coercion rather than accepting it > accepts an exact integer and proceeds past parsing 344ms
 ✓ tests/cli-replay.test.ts (37 tests) 1096ms
   ✓ flows replay > --json is byte-identical across two CLI invocations (diff) 748ms
 ✓ tests/gate-contract.test.ts (20 tests) 117ms
 ✓ tests/authored-node-result.test.ts (39 tests) 15ms
 ✓ tests/authored-human.test.ts (13 tests) 79ms
 ✓ tests/cloud-schedule.test.ts (17 tests) 3842ms
   ✓ schedule lowering > marks a non-grid cron as Cloud-only rather than approximating it, with a silence budget from its own cadence 1708ms
   ✓ flows check prints declared schedules > shows the lowering for a fixed interval and the Cloud-only note for a real cron 1655ms
 ✓ tests/direct-input.test.ts (6 tests) 5490ms
   ✓ direct .flow.ts input through the built CLI and live runtime > returns exit 3 for an authored human handoff and persists its outcome 615ms
   ✓ direct .flow.ts input through the built CLI and live runtime > returns exit 1 for an authored step_failed verdict and persists its outcome 650ms
   ✓ direct .flow.ts input through the built CLI and live runtime > executes inline and file JSON input through relayflowd 1957ms
   ✓ direct .flow.ts input through the built CLI and live runtime > refuses missing and malformed input before contacting relayflowd 1458ms
   ✓ direct .flow.ts input through the built CLI and live runtime > does not run the authored body before daemon availability 461ms
   ✓ direct .flow.ts input through the built CLI and live runtime > refuses oversized file input before contacting relayflowd 349ms
 ✓ tests/authored-run-failure-evidence.test.ts (9 tests) 896ms
   ✓ the child index after the process that wrote it is gone > still names every child, with its own run id, after a daemon restart 503ms
 ✓ tests/cli-hn-monitor.test.ts (16 tests) 96ms
 ✓ tests/wrapper-execution-duration.test.ts (7 tests) 10846ms
   ✓ keeps the handshake deadline independent of the removed execution deadline 10061ms
   ✓ still lets a lease abort stop an unlimited wrapper before it produces output 510ms
 ✓ tests/daemon-lifecycle-live.test.ts (9 tests) 6279ms
   ✓ flows run against a data dir with no daemon (§6 test 7) > cold start spawns exactly one daemon, the run succeeds, and the daemon outlives the CLI 444ms
   ✓ flows run against a data dir with no daemon (§6 test 7) > polls, bounded, for a daemon that holds the lock before it binds 1359ms
   ✓ flows run against a data dir with no daemon (§6 test 7) > attaches to a serving daemon that has not published a connection file 466ms
   ✓ flows run against a data dir with no daemon (§6 test 7) > a second run attaches to the daemon the first one started, spawning nothing 814ms
   ✓ flows run against a data dir with no daemon (§6 test 7) > detects a stale connection file left by a hard kill and starts a fresh daemon 885ms
   ✓ concurrent invocations against one empty data dir (§6 test 15) > ends with exactly one daemon owning the socket, and both runs succeed 1073ms
   ✓ refusals from a spawn that cannot produce a daemon > names relayflowd_not_found rather than falling through to PATH 396ms
   ✓ refusals from a spawn that cannot produce a daemon > names daemon_start_failed and quotes the daemon log when startup dies 419ms
   ✓ refusals from a spawn that cannot produce a daemon > refuses a daemon speaking another protocol version instead of binding over it 422ms
 ✓ tests/authored-step-index.test.ts (16 tests) 14ms
(node:50513) Warning: Transcript tail for run-9/analyze attempt 1 (stdout) could not be written; the step continues without it: EACCES: permission denied, mkdir '/tmp/transcript-tail-8Wam1V/runs/run-9/steps'
(Use `node --trace-warnings ...` to show where the warning was created)
 ✓ tests/transcript-tail.test.ts (11 tests) 938ms
   ✓ direct agent spawn > tees stdout and stderr into tail files that name the dispatch 420ms
   ✓ direct agent spawn > completes the step when the tail directory cannot be created 436ms
 ✓ tests/authored-agent-artifacts.test.ts (4 tests) 413ms
 ✓ tests/authored-helpers.test.ts (6 tests) 3712ms
   ✓ runs every available provider through the real kernel and resumes completed effects without a second write 2155ms
   ✓ replays after SIGKILL before confirm with the same token and one successful completion 482ms
   ✓ replays after SIGKILL before complete with the same token and one successful completion 537ms
 ✓ tests/babysitter-native-extension.test.ts (31 tests) 207ms
 ✓ tests/authored-flow-operation.test.ts (24 tests) 549ms
 ✓ tests/flow-requirements.test.ts (14 tests) 538ms
   ✓ flows check prints REQUIRES > names the helper, the harness and the mcp server of an authored flow 300ms
 ✓ tests/backlog-picker.test.ts (14 tests) 45ms
 ✓ tests/backlog-picker-flow.test.ts (6 tests) 302ms
 ✓ tests/preflight-permissions-unenforced.test.ts (17 tests) 212ms
 ✓ tests/wrapper-exit-drain.test.ts (8 tests) 2644ms
   ✓ reports a signalled wrapper death while a pipe is held, with its output intact 390ms
   ✓ lets a lease abort outrank a successful exit still being drained 532ms
 ✓ tests/stuck-run-triage.test.ts (22 tests) 3119ms
   ✓ stuck-run-triage shell text > collects tails with no GNU timeout on PATH, as on a stock macOS 3076ms
 ✓ tests/worker-transcript.test.ts (5 tests) 233ms
 ✓ tests/artifact-gates.test.ts (7 tests) 205ms
 ✓ tests/webhook.test.ts (9 tests) 575ms
   ✓ webhook ingress > checks TS declarations against flows.json without invoking handlers 508ms
 ✓ tests/webhook-live.test.ts (6 tests) 9773ms
   ✓ executes and deduplicates 'app_mention' only for its provider and matching payload 1539ms
   ✓ executes and deduplicates 'reaction_added' only for its provider and matching payload 1416ms
   ✓ executes and deduplicates 'pull_request' only for its provider and matching payload 1441ms
   ✓ flows serve-webhook writes JSON before the daemon starts, then journals and archives exactly once 1467ms
   ✓ replays a dropped file after SIGKILL before spawn 444ms
   ✓ resumes the same journal after SIGKILL after spawn and before acknowledgement 3465ms
 ✓ tests/agent-artifacts-live.test.ts (5 tests) 43694ms
   ✓ agent artifacts and gates through the built CLI, a real daemon and the local agent > journals the files the agent wrote, including under a dot-directory, and every artifact gate passes on that journal 1201ms
   ✓ agent artifacts and gates through the built CLI, a real daemon and the local agent > fails the run when the artifact_exists gate names a file the agent did not write 15101ms
   ✓ agent artifacts and gates through the built CLI, a real daemon and the local agent > fails the run with the author reason when a predicate gate returns false, journaling the verdict 13131ms
   ✓ review follow-ups > applies a predicate gate on a helper step too, and journals its verdict 13237ms
   ✓ review follow-ups > records predicate verdicts on the root run so a resume reuses them instead of re-running the closure 1023ms
 ✓ tests/agent-transcript-live.test.ts (4 tests) 44320ms
   ✓ the transcript digest through the built CLI, a real daemon and the local agent > preserves structured agent failure details and its completed root index 12884ms
   ✓ the transcript digest through the built CLI, a real daemon and the local agent > preserves structured llm failure details and its completed root index 15499ms
   ✓ the transcript digest through the built CLI, a real daemon and the local agent > journals the digest in trajectory_tail on a successful agent step and writes the file it points at 783ms
   ✓ the transcript digest through the built CLI, a real daemon and the local agent > on a failed agent step, names the failure and the transcript in the terminal diagnostic, redacted 15153ms
 ✓ tests/authored-step-failed.test.ts (10 tests) 98ms
 ✓ tests/human-live.test.ts (3 tests) 12066ms
   ✓ f.human against a real daemon > parks with the question, refuses wrong answers, records one, and resumes to success 7271ms
   ✓ f.human against a real daemon > a "no" is a value the body branches on: declined, exit 0, no effect 2932ms
   ✓ f.human against a real daemon > refuses to answer a run the daemon does not know 1862ms
 ✓ tests/budget-preflight.test.ts (25 tests) 14ms
 ✓ tests/cli-watch.test.ts (10 tests) 24412ms
   ✓ flows check --watch > rechecks syntax errors, clears once, and returns the last refusal on Ctrl-C 1952ms
   ✓ flows check --watch > streams JSON lines without ANSI, recovers after atomic saves, and exits zero after repair 2560ms
   ✓ flows check --watch > coalesces 20 concurrent saves into at most two rechecks 2255ms
   ✓ flows check --watch > watches transitive relative use imports, cycles, and nearest config changes 4531ms
   ✓ flows check --watch > refreshes the import graph and notices missing imports being created 3907ms
   ✓ flows check --watch > reloads authored TypeScript instead of reusing the first imported definition 2698ms
   ✓ flows check --watch > detects a nearer config appearing and falls back after it is deleted 3124ms
   ✓ flows check --watch > keeps watching after the target is deleted and recreated 2607ms
   ✓ flows check --watch > queues changes during a slow check without overlapping checks 775ms
 ✓ tests/budget-unmetered-live.test.ts (3 tests) 1499ms
   ✓ unmetered budget spend through the live kernel > runs an unpriced step under a dollar budget without tripping it, journaling unknown dollars 795ms
   ✓ unmetered budget spend through the live kernel > accrues a priced step and stops the run when it crosses the dollar budget 451ms
 ✓ tests/provider-trigger-contract.test.ts (7 tests) 654ms
   ✓ provider trigger contract > fails `flows check` before deployment and passes once the event is real 454ms
 ✓ tests/work-package-consumer.test.ts (13 tests) 118ms
 ✓ tests/spec-parity.test.ts (31 tests) 353ms
 ✓ tests/helpers-fanout.test.ts (96 tests) 159ms
 ✓ tests/generate-triggers.test.ts (7 tests) 1088ms
   ✓ discovers new adapters, preserves exact event names, and prefers adapter-local mappings 325ms
 ✓ tests/authored-parallel-agents.test.ts (8 tests) 12803ms
   ✓ authored steps under local workers with capacity > runs more concurrent f.llm calls than the worker holds side by side, never more than its capacity 1502ms
   ✓ authored steps under local workers with capacity > completes more concurrent f.agent calls than the worker holds: the overflow waits for a slot instead of parking 3102ms
   ✓ authored steps under local workers with capacity > runs agents in distinct working directories side by side (the kernel carries cwd) 698ms
   ✓ authored steps under local workers with capacity > serializes agents whose cwd is a symlink alias of the same directory 1108ms
   ✓ authored steps under local workers with capacity > serializes agents whose cwd is a directory nested inside the other 1130ms
   ✓ authored steps under local workers with capacity > never starts queued agents once the body has failed 2032ms
   ✓ authored steps under local workers with capacity > never starts a queued agent when the agent holding the only slot fails 2115ms
   ✓ authored steps under local workers with capacity > parks the overflow when the body is not told the capacity (the defect this closes) 1115ms
 ✓ tests/webhook-hardening.test.ts (11 tests) 54ms
 ✓ tests/human-to.test.ts (8 tests) 9ms
 ✓ tests/plugin-loader.test.ts (9 tests) 180ms
 ✓ tests/pty-sidechannel.test.ts (11 tests) 6160ms
   ✓ view attach preserves worker completion and marks only drive 881ms
   ✓ drive attach preserves worker completion and marks only drive 326ms
   ✓ passthrough attach preserves worker completion and marks only drive 832ms
   ✓ none attach preserves worker completion and marks only drive 839ms
   ✓ none subscriber lets an unattended CLI read EOF 447ms
   ✓ view subscriber lets an unattended CLI read EOF 467ms
   ✓ passthrough subscriber lets an unattended CLI read EOF 444ms
   ✓ incomplete subscriber lets an unattended CLI read EOF 477ms
   ✓ rejects drive after EOF without marking human intervention 770ms
   ✓ delivers all drive bytes in order across child stdin backpressure 674ms
 ✓ tests/worker-lease.test.ts (7 tests) 10ms
 ✓ tests/yaml-helpers.test.ts (33 tests) 66ms
 ✓ tests/authored-agent-permissions.test.ts (26 tests) 779ms
 ✓ tests/worker-cli-result-exit.test.ts (5 tests) 32914ms
   ✓ a Claude agent step completes on its result, not only on process exit > settles a hung, successful run within the grace and stops its whole tree 31701ms
   ✓ a Claude agent step completes on its result, not only on process exit > maps an error result on a hung run to a failed exit 31741ms
   ✓ a Claude agent step completes on its result, not only on process exit > leaves a hang before any result to the existing stops 32016ms
   ✓ an agent tree does not outlive the process that spawned it > kills the agent group when the run process is terminated by SIGTERM 803ms
 ✓ tests/babysitter-catalog-export.test.ts (14 tests) 793ms
   ✓ Babysitter catalog artifact export > CLI refuses an existing output and leaves no file on validation failure 582ms
 ✓ tests/redact.test.ts (35 tests) 9ms
 ✓ tests/communication.test.ts (10 tests) 17ms
 ✓ tests/deploy.test.ts (11 tests) 5406ms
   ✓ flows deploy file buckets > publishes the full signed layout byte-for-byte and redeploys as a noop 819ms
   ✓ flows deploy file buckets > answers --json with one object per outcome 761ms
   ✓ flows deploy file buckets > reports a refusal as JSON under --json 358ms
   ✓ flows deploy file buckets > refuses a missing local bundle before creating the bucket 404ms
   ✓ flows deploy file buckets > refuses an unreachable bucket before copying 397ms
   ✓ flows deploy file buckets > refuses an unwritable bucket 375ms
   ✓ flows deploy file buckets > refuses local tampering of spec.canonical.json 401ms
   ✓ flows deploy file buckets > refuses local tampering of identity.json 370ms
   ✓ flows deploy file buckets > refuses asset bundles instead of using daemon-relative files 444ms
   ✓ flows deploy file buckets > never labels a corrupt existing deployment as a noop 1036ms
 ✓ tests/typed-output.test.ts (14 tests) 307ms
 ✓ tests/canonical-software-factory.test.ts (3 tests) 112ms
 ✓ tests/budget-attribution.test.ts (5 tests) 7ms
 ✓ tests/effect-channel.test.ts (5 tests) 528ms
 ✓ tests/mcp-lifecycle.test.ts (4 tests) 12ms
 ✓ tests/model-selection.test.ts (10 tests) 46ms
 ✓ tests/json-schema-bound.test.ts (71 tests) 2325ms
   ✓ JSON Schema termination bound > walks a deep schema with an explicit stack rather than recursion 1843ms
 ✓ tests/relayflowd-path.test.ts (10 tests) 4ms
 ✓ tests/agent-artifacts.test.ts (9 tests) 20ms
 ✓ tests/f-memory.test.ts (7 tests) 1038ms
 ✓ tests/authored-plugin-effect.test.ts (6 tests) 76ms
 ✓ tests/yaml-local-agent-live.test.ts (7 tests) 4032ms
   ✓ YAML --local-agent through the built CLI and real daemon > runs with the checked step CLI and model and journals done 683ms
   ✓ YAML --local-agent through the built CLI and real daemon > runs with the checked named CLI and model and journals done 606ms
   ✓ YAML --local-agent through the built CLI and real daemon > runs with the checked flow CLI and model and journals done 589ms
   ✓ YAML --local-agent through the built CLI and real daemon > runs with the checked project CLI and model and journals done 554ms
   ✓ YAML --local-agent through the built CLI and real daemon > still parks without --local-agent 482ms
   ✓ YAML --local-agent through the built CLI and real daemon > reports the agent process failure 572ms
   ✓ YAML --local-agent through the built CLI and real daemon > preserves declared workspace surfaces that the local worker cannot pin 545ms
 ✓ tests/worker-slots.test.ts (7 tests) 7ms
 ✓ tests/local-dev-ux.test.ts (8 tests) 18ms
 ✓ tests/relay-cli-surface-live.test.ts (3 tests) 454ms
 ✓ tests/authored-declined.test.ts (13 tests) 48ms
 ✓ tests/resume-failure.test.ts (2 tests) 5ms
 ✓ tests/dependency-validation.test.ts (6 tests) 606ms
   ✓ dependency validation > accepts a valid 10,000-step reverse chain through every direct public boundary 339ms
 ✓ tests/authored-hooks.test.ts (5 tests) 5ms
 ✓ tests/input-binding.test.ts (12 tests) 208ms
 ✓ tests/communication-review.test.ts (5 tests) 331ms
 ✓ tests/yaml-helper-effect.test.ts (4 tests) 80ms
 ✓ tests/authored-step-graph-live.test.ts (1 test) 656ms
   ✓ the authored step DAG through the live kernel > carries labels and predecessors on every index record and journal step, ids unchanged 655ms
 ✓ tests/deterministic-llm.test.ts (5 tests) 50ms
 ✓ tests/scope-preflight.test.ts (6 tests) 10ms
 ✓ tests/bin.test.ts (7 tests) 2226ms
   ✓ built flows binary > refuses through a symlink to the built artifact 363ms
   ✓ built flows binary > refuses through a symlinked directory component 365ms
   ✓ built flows binary > classifies a signal-terminated auth probe as probe_failed 370ms
   ✓ built flows binary > classifies an unavailable PATH resolver as probe_failed 366ms
   ✓ built flows binary > does not describe a present non-executable CLI as missing 372ms
   ✓ built flows binary > runs one auth probe for three steps sharing a flow CLI 388ms
 ✓ tests/build-gate.test.ts (3 tests) 1077ms
   ✓ flows build gates on flows check green (#318) > refuses a flow with an unresolvable named-agent CLI and leaves no artifacts 358ms
   ✓ flows build gates on flows check green (#318) > --json emits one CheckReport object on stdout on refusal, exits 2, no artifacts 356ms
   ✓ flows build gates on flows check green (#318) > builds the bundle on success (regression: gate must not block valid flows) 361ms
 ✓ tests/scope-compiler.test.ts (25 tests) 10ms
 ✓ tests/run-from-digest.test.ts (6 tests) 4165ms
   ✓ flows run digest input > submits the sealed canonical spec through the normal journal path without checkout 421ms
   ✓ flows run digest input > uses a verified cache hit even after the bucket is removed 396ms
   ✓ flows run digest input > resolves deploy.bucket from flows.json and honors explicit override 1114ms
   ✓ flows run digest input > refuses an unconfigured bucket 734ms
   ✓ flows run digest input > refuses tampered spec.canonical.json before creating run data 752ms
   ✓ flows run digest input > refuses tampered identity.json before creating run data 746ms
 ✓ tests/communication-worker.test.ts (15 tests) 1501ms
 ✓ tests/hn-poller.test.ts (6 tests) 5ms
 ✓ tests/plugin-add.test.ts (7 tests) 1152ms
   ✓ typechecks the augmented verb and rejects unknown namespaces 863ms
 ✓ tests/authored-step-failed-exit.test.ts (3 tests) 7ms
 ✓ tests/direct-run-failure.test.ts (8 tests) 11ms
 ✓ tests/dir-watcher-poller.test.ts (6 tests) 4ms
 ✓ tests/model-pricing.test.ts (10 tests) 5ms
 ✓ tests/yaml-helper-live.test.ts (1 test) 899ms
   ✓ runs compiled YAML helpers through the built CLI and kernel effect journal 899ms
 ✓ tests/provider-trigger-executor.test.ts (4 tests) 324ms
 ✓ tests/transcript-tail-close.test.ts (2 tests) 1076ms
   ✓ a stalled transcript-tail close > does not hold the spawn open past its bounded window 543ms
   ✓ a stalled tail close beside a transcript that finished > still journals the transcript pointer 532ms
 ✓ tests/wrapper-artifacts-cwd.test.ts (2 tests) 71ms
 ✓ tests/hello-deterministic.test.ts (5 tests) 16ms
 ✓ tests/transcript-exclusion-timeout.test.ts (1 test) 194ms
 ✓ tests/cli-adapter.test.ts (4 tests) 6ms
 ✓ tests/communication-mixed-resume.test.ts (1 test) 209ms
 ✓ tests/work-package-validator.test.ts (7 tests) 5ms
 ✓ tests/authored-use-loader.test.ts (5 tests) 595ms
 ✓ tests/authored-declined-live.test.ts (1 test) 1607ms
   ✓ runs an input guard and resumes its completed declined root without repeated effects 1606ms
 ✓ tests/cli-answer.test.ts (15 tests) 8ms
 ✓ tests/bundle-preflight.test.ts (4 tests) 878ms
   ✓ bundle execution preflight > ignores surrounding cache configuration on a verified cache hit 418ms
   ✓ bundle execution preflight > uses the built alias for a nameless flow even in a digest-only cache directory 420ms
 ✓ tests/agent-relay-hardening.test.ts (12 tests) 12ms
 ✓ tests/classify-outcome.test.ts (2 tests) 2163ms
   ✓ classifyOutcome > gives up and reports when a running run never becomes classifiable 2007ms
 ✓ tests/communication-preflight.test.ts (13 tests) 40ms
 ↓ tests/real-cli-adapters.test.ts (3 tests | 3 skipped)
 ✓ tests/memoization.test.ts (57 tests) 64ms
 ✓ tests/failure-capture-digest.test.ts (7 tests) 34ms
 ✓ tests/parse-json-output.test.ts (7 tests) 3ms
 ✓ tests/journal-client-completion.test.ts (4 tests) 101ms
 ✓ tests/worker-cli-abort.test.ts (2 tests) 2675ms
   ✓ stops claude and its process group when lease ownership is lost 1325ms
   ✓ stops wrapper.mjs and its process group when lease ownership is lost 1349ms
 ✓ tests/communication-environment-preflight.test.ts (6 tests) 3ms
 ✓ tests/budget-authored-live.test.ts (2 tests) 179ms
 ✓ tests/slack-writeback.test.ts (1 test) 259ms
 ✓ tests/authored-surface-authority.test.ts (2 tests) 17ms
 ✓ tests/adapters/claude.test.ts (7 tests) 4ms
 ✓ tests/worker-cli-cwd.test.ts (2 tests) 277ms
 ✓ tests/adapters/codex.test.ts (7 tests) 4ms
 ✓ tests/slack-block-kit.test.ts (5 tests) 13ms
 ✓ tests/communication-history.test.ts (1 test) 3ms
 ✓ tests/adapters/registry.test.ts (4 tests) 4ms
 ✓ tests/authored-declined-report.test.ts (6 tests) 7ms
 ✓ tests/promise-ancestry.test.ts (2 tests) 288ms
 ✓ tests/communication-refusal.test.ts (1 test) 13ms
 ✓ tests/agent-cwd-validation.test.ts (2 tests) 364ms
   ✓ declarative agent cwd > is refused by `flows check` on a YAML flow before anything runs 361ms
 ✓ tests/bundle-transport.test.ts (20 tests) 2414ms
   ✓ digest references > accepts and deploys the build output for hello 385ms
   ✓ digest references > accepts and deploys the build output for Hello 380ms
   ✓ digest references > accepts and deploys the build output for hello.world 388ms
   ✓ digest references > accepts and deploys the build output for hello_world 437ms
   ✓ digest references > accepts and deploys the build output for 123 422ms
   ✓ digest references > accepts and deploys the build output for A_b.c-1 401ms
 ✓ tests/catalog-plugins.test.ts (2 tests) 3ms
 ✓ tests/check-command-cwd.test.ts (1 test) 12ms
 ✓ tests/communication-lazy.test.ts (1 test) 3ms
 ✓ tests/step-lease.test.ts (36 tests) 66527ms
   ✓ f.run leases against the live kernel > enforces 10000 ms for 'sleep 5; printf ok' 5073ms
   ✓ f.run leases against the live kernel > enforces 40000 ms for 'sleep 31; printf ok' 31090ms
   ✓ f.run leases against the live kernel > enforces 30000 ms for 'sleep 31; printf ok' 30139ms
 ✓ tests/cli-progress-wait.test.ts (2 tests) 3ms
 ✓ tests/placement.test.ts (54 tests) 15ms
 ✓ tests/canonical-tree.test.ts (1 test) 3ms
 ✓ tests/run-digest-live.test.ts (1 test) 925ms
   ✓ executes a deployed digest on the real kernel after deleting the authoring tree 924ms
 ✓ tests/communication-tools.test.ts (1 test) 89ms
 ✓ tests/authored-admission.test.ts (2 tests) 3ms
 ✓ tests/memory.test.ts (18 tests) 7ms
 ✓ tests/worker-platform.test.ts (1 test) 3ms
 ✓ tests/run-digest.test.ts (4 tests) 1542ms
   ✓ digest run configuration refusals > reports config_invalid before fetching or starting a run for {invalid json 435ms
   ✓ digest run configuration refusals > reports config_invalid before fetching or starting a run for {"deploy":{}} 348ms
   ✓ digest run configuration refusals > reports config_invalid before fetching or starting a run for {"deploy":{"bucket":123}} 399ms
   ✓ digest run configuration refusals > reports config_invalid before fetching or starting a run for {"deploy":{"bucket":""}} 359ms
 ✓ tests/local-agent-live.test.ts (5 tests) 64766ms
   ✓ built CLI local agent against a real daemon > dispatches through the wrapper and keeps --json stdout report-shaped 856ms
   ✓ built CLI local agent against a real daemon > runs beyond the initial 30-second lease without a second invocation 35954ms
   ✓ built CLI local agent against a real daemon > renders actual agent completion in text output 809ms
   ✓ built CLI local agent against a real daemon > returns a failed run when the agent process fails 14485ms
   ✓ built CLI local agent against a real daemon > refuses a workspace it cannot pin before invoking the agent 12661ms

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/authored-node-runtime.test.ts [ tests/authored-node-runtime.test.ts ]
AssertionError: expected '1.3.6' to be '1.4.0' // Object.is equality

Expected: "1.4.0"
Received: "1.3.6"

 ❯ tests/authored-node-runtime.test.ts:18:77
     16| 
     17| beforeAll(() => {
     18|   expect(spawnSync(bun, ['--version'], { encoding: 'utf8' }).stdout.tr…
       |                                                                             ^
     19|   expect(existsSync(daemon), 'build the current kernel or set RELAYFLO…
     20|   stage = mkdtempSync(join(tmpdir(), 'authored-standalone-build-'));

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/9]⎯

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 8 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/live-kernel.test.ts > built flows CLI against live relayflowd > runs hn-monitor analyze-story end-to-end via a stub agent CLI (gate 2 clause 2 demo)
AssertionError: expected { …(12) } to match object { output: { …(3) }, …(1) }
(22 matching properties omitted from actual)

- Expected
+ Received

  Object {
-   "output": Object {
-     "reasoning": "stub agent runtime — deterministic output for gate-2 clause-2 demo",
-     "relevance_score": 5,
-     "story_title": "stub",
-   },
+   "output": null,
    "verification": Object {
-     "gate": "json_schema",
-     "verdict": "pass",
+     "gate": "execution",
+     "verdict": "fail",
    },
  }

 ❯ tests/live-kernel.test.ts:657:36
    655|         && (entry as { step_id?: string }).step_id === 'analyze-story',
    656|     ) as { payload: { output: unknown; verification: unknown } } | und…
    657|     expect(stepCompleted?.payload).toMatchObject({
       |                                    ^
    658|       output: {
    659|         story_title: 'stub',

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/9]⎯

 FAIL  tests/live-kernel.test.ts > built flows CLI against live relayflowd > hn-monitor analyze-story FAILS verification when the CLI omits required schema fields
AssertionError: expected { …(12) } to match object { …(3) }
(21 matching properties omitted from actual)

- Expected
+ Received

  Object {
-   "completionReason": "retries_exhausted",
+   "completionReason": "worker_error",
    "output": null,
    "verification": Object {
-     "gate": "json_schema",
+     "gate": "execution",
      "verdict": "fail",
    },
  }

 ❯ tests/live-kernel.test.ts:752:36
    750|     // its verification record names the json_schema rejection. The re…
    751|     // parsed value is nulled before the completion is persisted.
    752|     expect(stepCompleted?.payload).toMatchObject({
       |                                    ^
    753|       completionReason: 'retries_exhausted',
    754|       output: null,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/9]⎯

 FAIL  tests/live-kernel.test.ts > built flows CLI against live relayflowd > agent step preserves the CliResult wrapper as output when the CLI emits non-JSON text
AssertionError: expected null not to be null
 ❯ tests/live-kernel.test.ts:823:24
    821|     // here (parseJsonOutput returned null on non-JSON stdout) and
    822|     // these assertions would all fail.
    823|     expect(output).not.toBeNull();
       |                        ^
    824|     expect(output.exit_code).toBe(0);
    825|     expect(output.stdout_tail).toContain('looked at the story');

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/9]⎯

 FAIL  tests/live-kernel.test.ts > built flows CLI against live relayflowd > AgentWorker exposes wake_context to the CLI via RELAYFLOW_WAKE_CONTEXT env var (real analyzer prerequisite)
TypeError: Cannot read properties of null (reading 'story_title')
 ❯ tests/live-kernel.test.ts:891:42
    889|     ) as { payload: { output: { story_title: string; reasoning: string…
    890|     expect(stepCompleted).toBeDefined();
    891|     expect(stepCompleted!.payload.output.story_title).toBe(`echoed:${s…
       |                                          ^
    892|     expect(stepCompleted!.payload.output.reasoning).toContain(String(s…
    893| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[5/9]⎯

 FAIL  tests/live-kernel.test.ts > built flows CLI against live relayflowd > AgentWorker leaves RELAYFLOW_WAKE_CONTEXT UNSET when the run has no wake_context (undefined-vs-null pin)
TypeError: Cannot read properties of null (reading 'env_present')
 ❯ tests/live-kernel.test.ts:958:38
    956|     ) as { payload: { output: { env_present: boolean } } } | undefined;
    957|     expect(completed).toBeDefined();
    958|     expect(completed!.payload.output.env_present).toBe(false);
       |                                      ^
    959| 
    960|     delete process.env.RELAYFLOW_WAKE_CONTEXT;

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[6/9]⎯

 FAIL  tests/live-kernel.test.ts > built flows CLI against live relayflowd > AgentWorker leaves RELAYFLOW_MODEL UNSET when the step declares no model
TypeError: Cannot read properties of null (reading 'story_title')
 ❯ tests/live-kernel.test.ts:1194:38
    1192|     expect(completed).toBeDefined();
    1193|     // UNSET, not EMPTY and not the leaked parent value.
    1194|     expect(completed!.payload.output.story_title).toBe('model:UNSET');
       |                                      ^
    1195| 
    1196|     delete process.env.RELAYFLOW_MODEL;

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[7/9]⎯

 FAIL  tests/live-kernel.test.ts > built flows CLI against live relayflowd > hn-monitor analyze-story reaches done through the real Claude analyzer CLI
Error: LIVE_ANALYZER_UNAVAILABLE: "/home/daytona/.relayflow-v2-supervisor/durable/repository/testdata/preflight/analyze-story-claude-cli" does not identify as relayflows-agent-cli-v1 — failing because gate-2 acceptance requires the real analyzer to execute. Set RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 only if this run is not gate evidence.
 ❯ tests/live-kernel.test.ts:1223:15
    1221|       const notice = `LIVE_ANALYZER_UNAVAILABLE: ${readiness.detail}`;
    1222|       if (process.env['RELAYFLOWS_ALLOW_ANALYZER_SKIP'] !== '1') {
    1223|         throw new Error(
       |               ^
    1224|           `${notice} — failing because gate-2 acceptance requires the …
    1225|           + 'Set RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 only if this run is …

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[8/9]⎯

 FAIL  tests/live-kernel.test.ts > a relayflow can be scheduled: tick source against live relayflowd > a tick spawns a real run whose step reports the SCHEDULED instant
AssertionError: expected null to deeply equal { schedule_id: 'heartbeat-1m', …(3) }

- Expected: 
Object {
  "lag_ms": 43000,
  "schedule_id": "heartbeat-1m",
  "scheduled_for_ms": 1764000000000,
  "slot": 29400000,
}

+ Received: 
null

 ❯ tests/live-kernel.test.ts:1665:39
    1663|     // The bound: the run reports the grid instant and its own lag, so…
    1664|     // backfilled run can tell it is running for a slot from the past.
    1665|     expect(completed!.payload.output).toEqual({
       |                                       ^
    1666|       schedule_id: 'heartbeat-1m',
    1667|       slot: 29_400_000,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[9/9]⎯

 Test Files  2 failed | 173 passed | 1 skipped (176)
      Tests  8 failed | 2777 passed | 17 skipped (2802)
   Start at  00:04:13
   Duration  219.77s (transform 3.36s, setup 0ms, collect 42.78s, tests 571.11s, environment 23ms, prepare 7.42s)


```

</details>

<details>
<summary>baseline-matched-location: literal command and captured output</summary>

```text
$ cd /home/daytona/.relayflow-v2-supervisor/durable/capture-baseline/packages/sdk && RELAYFLOWD_BIN=/tmp/relayflow-capture-baseline-target/debug/relayflowd npx vitest run tests/live-kernel.test.ts tests/authored-node-runtime.test.ts

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/capture-baseline/packages/sdk

 ❯ tests/authored-node-runtime.test.ts (14 tests | 14 skipped) 10ms
stdout | tests/live-kernel.test.ts
LIVE_KERNEL relayflowd=/tmp/relayflow-capture-baseline-target/debug/relayflowd
LIVE_KERNEL flows=/home/daytona/.relayflow-v2-supervisor/durable/capture-baseline/packages/sdk/dist/cli.js

stdout | tests/live-kernel.test.ts > surface resume after a real daemon kill > resumes a three-step run with each successful completion exactly once
LIVE_KERNEL kill -9 pid=63248 run=01M35SJR7SP81SNNCSCZ01QMK7 while step=two state=Running

 ❯ tests/live-kernel.test.ts (31 tests | 8 failed) 52739ms
   ✓ built flows CLI against live relayflowd > twenty-six-step reuses 25 durable completions after editing the failed final step 2331ms
   ✓ built flows CLI against live relayflowd > runs rung (a), parks rung (b), and keeps JSON report-shaped 2605ms
   ✓ built flows CLI against live relayflowd > allows a deterministic run to exceed the bounded request timeout 32435ms
   ✓ built flows CLI against live relayflowd > follows a live worker dispatch through flows run 561ms
   ✓ built flows CLI against live relayflowd > runs an agent CLI end to end through the SDK worker 413ms
   ✓ built flows CLI against live relayflowd > f.agent lowers to a real agent step and dispatches through a live worker 504ms
   ✓ built flows CLI against live relayflowd > can always get a parked run to a late-attaching worker 5584ms
   ✓ built flows CLI against live relayflowd > reports a real manual-recovery NeedsHuman state as parked 425ms
   × built flows CLI against live relayflowd > runs hn-monitor analyze-story end-to-end via a stub agent CLI (gate 2 clause 2 demo) 489ms
     → expected { …(12) } to match object { output: { …(3) }, …(1) }
(22 matching properties omitted from actual)
   × built flows CLI against live relayflowd > hn-monitor analyze-story FAILS verification when the CLI omits required schema fields 443ms
     → expected { …(12) } to match object { …(3) }
(21 matching properties omitted from actual)
   × built flows CLI against live relayflowd > agent step preserves the CliResult wrapper as output when the CLI emits non-JSON text 514ms
     → expected null not to be null
   × built flows CLI against live relayflowd > AgentWorker exposes wake_context to the CLI via RELAYFLOW_WAKE_CONTEXT env var (real analyzer prerequisite) 529ms
     → Cannot read properties of null (reading 'story_title')
   × built flows CLI against live relayflowd > AgentWorker leaves RELAYFLOW_WAKE_CONTEXT UNSET when the run has no wake_context (undefined-vs-null pin) 414ms
     → Cannot read properties of null (reading 'env_present')
   ✓ built flows CLI against live relayflowd > AgentWorker passes a declared model to an identified wrapper as RELAYFLOW_MODEL 502ms
   ✓ built flows CLI against live relayflowd > AgentWorker refuses a nonconforming journal-submitted wrapper before exposing RELAYFLOW_MODEL 408ms
   ✓ built flows CLI against live relayflowd > AgentWorker executes the raw claude adapter with its real model flag 429ms
   ✓ built flows CLI against live relayflowd > AgentWorker executes the raw codex adapter with its real model flag 378ms
   × built flows CLI against live relayflowd > AgentWorker leaves RELAYFLOW_MODEL UNSET when the step declares no model 375ms
     → Cannot read properties of null (reading 'story_title')
   × built flows CLI against live relayflowd > hn-monitor analyze-story reaches done through the real Claude analyzer CLI 28ms
     → LIVE_ANALYZER_UNAVAILABLE: "/home/daytona/.relayflow-v2-supervisor/durable/capture-baseline/testdata/preflight/analyze-story-claude-cli" does not identify as relayflows-agent-cli-v1 — failing because gate-2 acceptance requires the real analyzer to execute. Set RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 only if this run is not gate evidence.
   ✓ built flows CLI against live relayflowd > preflights before journaling and names an unreachable socket 870ms
   ✓ built flows CLI against live relayflowd > starts exactly one daemon when two runs race for one empty data dir 475ms
   ✓ surface resume after a real daemon kill > resumes a three-step run with each successful completion exactly once 847ms
   × a relayflow can be scheduled: tick source against live relayflowd > a tick spawns a real run whose step reports the SCHEDULED instant 442ms
     → expected null to deeply equal { schedule_id: 'heartbeat-1m', …(3) }

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/authored-node-runtime.test.ts [ tests/authored-node-runtime.test.ts ]
AssertionError: expected '1.3.6' to be '1.4.0' // Object.is equality

Expected: "1.4.0"
Received: "1.3.6"

 ❯ tests/authored-node-runtime.test.ts:18:77
     16| 
     17| beforeAll(() => {
     18|   expect(spawnSync(bun, ['--version'], { encoding: 'utf8' }).stdout.tr…
       |                                                                             ^
     19|   expect(existsSync(daemon), 'build the current kernel or set RELAYFLO…
     20|   stage = mkdtempSync(join(tmpdir(), 'authored-standalone-build-'));

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/9]⎯

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 8 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/live-kernel.test.ts > built flows CLI against live relayflowd > runs hn-monitor analyze-story end-to-end via a stub agent CLI (gate 2 clause 2 demo)
AssertionError: expected { …(12) } to match object { output: { …(3) }, …(1) }
(22 matching properties omitted from actual)

- Expected
+ Received

  Object {
-   "output": Object {
-     "reasoning": "stub agent runtime — deterministic output for gate-2 clause-2 demo",
-     "relevance_score": 5,
-     "story_title": "stub",
-   },
+   "output": null,
    "verification": Object {
-     "gate": "json_schema",
-     "verdict": "pass",
+     "gate": "execution",
+     "verdict": "fail",
    },
  }

 ❯ tests/live-kernel.test.ts:657:36
    655|         && (entry as { step_id?: string }).step_id === 'analyze-story',
    656|     ) as { payload: { output: unknown; verification: unknown } } | und…
    657|     expect(stepCompleted?.payload).toMatchObject({
       |                                    ^
    658|       output: {
    659|         story_title: 'stub',

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/9]⎯

 FAIL  tests/live-kernel.test.ts > built flows CLI against live relayflowd > hn-monitor analyze-story FAILS verification when the CLI omits required schema fields
AssertionError: expected { …(12) } to match object { …(3) }
(21 matching properties omitted from actual)

- Expected
+ Received

  Object {
-   "completionReason": "retries_exhausted",
+   "completionReason": "worker_error",
    "output": null,
    "verification": Object {
-     "gate": "json_schema",
+     "gate": "execution",
      "verdict": "fail",
    },
  }

 ❯ tests/live-kernel.test.ts:752:36
    750|     // its verification record names the json_schema rejection. The re…
    751|     // parsed value is nulled before the completion is persisted.
    752|     expect(stepCompleted?.payload).toMatchObject({
       |                                    ^
    753|       completionReason: 'retries_exhausted',
    754|       output: null,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[3/9]⎯

 FAIL  tests/live-kernel.test.ts > built flows CLI against live relayflowd > agent step preserves the CliResult wrapper as output when the CLI emits non-JSON text
AssertionError: expected null not to be null
 ❯ tests/live-kernel.test.ts:823:24
    821|     // here (parseJsonOutput returned null on non-JSON stdout) and
    822|     // these assertions would all fail.
    823|     expect(output).not.toBeNull();
       |                        ^
    824|     expect(output.exit_code).toBe(0);
    825|     expect(output.stdout_tail).toContain('looked at the story');

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[4/9]⎯

 FAIL  tests/live-kernel.test.ts > built flows CLI against live relayflowd > AgentWorker exposes wake_context to the CLI via RELAYFLOW_WAKE_CONTEXT env var (real analyzer prerequisite)
TypeError: Cannot read properties of null (reading 'story_title')
 ❯ tests/live-kernel.test.ts:891:42
    889|     ) as { payload: { output: { story_title: string; reasoning: string…
    890|     expect(stepCompleted).toBeDefined();
    891|     expect(stepCompleted!.payload.output.story_title).toBe(`echoed:${s…
       |                                          ^
    892|     expect(stepCompleted!.payload.output.reasoning).toContain(String(s…
    893| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[5/9]⎯

 FAIL  tests/live-kernel.test.ts > built flows CLI against live relayflowd > AgentWorker leaves RELAYFLOW_WAKE_CONTEXT UNSET when the run has no wake_context (undefined-vs-null pin)
TypeError: Cannot read properties of null (reading 'env_present')
 ❯ tests/live-kernel.test.ts:958:38
    956|     ) as { payload: { output: { env_present: boolean } } } | undefined;
    957|     expect(completed).toBeDefined();
    958|     expect(completed!.payload.output.env_present).toBe(false);
       |                                      ^
    959| 
    960|     delete process.env.RELAYFLOW_WAKE_CONTEXT;

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[6/9]⎯

 FAIL  tests/live-kernel.test.ts > built flows CLI against live relayflowd > AgentWorker leaves RELAYFLOW_MODEL UNSET when the step declares no model
TypeError: Cannot read properties of null (reading 'story_title')
 ❯ tests/live-kernel.test.ts:1194:38
    1192|     expect(completed).toBeDefined();
    1193|     // UNSET, not EMPTY and not the leaked parent value.
    1194|     expect(completed!.payload.output.story_title).toBe('model:UNSET');
       |                                      ^
    1195| 
    1196|     delete process.env.RELAYFLOW_MODEL;

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[7/9]⎯

 FAIL  tests/live-kernel.test.ts > built flows CLI against live relayflowd > hn-monitor analyze-story reaches done through the real Claude analyzer CLI
Error: LIVE_ANALYZER_UNAVAILABLE: "/home/daytona/.relayflow-v2-supervisor/durable/capture-baseline/testdata/preflight/analyze-story-claude-cli" does not identify as relayflows-agent-cli-v1 — failing because gate-2 acceptance requires the real analyzer to execute. Set RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 only if this run is not gate evidence.
 ❯ tests/live-kernel.test.ts:1223:15
    1221|       const notice = `LIVE_ANALYZER_UNAVAILABLE: ${readiness.detail}`;
    1222|       if (process.env['RELAYFLOWS_ALLOW_ANALYZER_SKIP'] !== '1') {
    1223|         throw new Error(
       |               ^
    1224|           `${notice} — failing because gate-2 acceptance requires the …
    1225|           + 'Set RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 only if this run is …

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[8/9]⎯

 FAIL  tests/live-kernel.test.ts > a relayflow can be scheduled: tick source against live relayflowd > a tick spawns a real run whose step reports the SCHEDULED instant
AssertionError: expected null to deeply equal { schedule_id: 'heartbeat-1m', …(3) }

- Expected: 
Object {
  "lag_ms": 43000,
  "schedule_id": "heartbeat-1m",
  "scheduled_for_ms": 1764000000000,
  "slot": 29400000,
}

+ Received: 
null

 ❯ tests/live-kernel.test.ts:1665:39
    1663|     // The bound: the run reports the grid instant and its own lag, so…
    1664|     // backfilled run can tell it is running for a slot from the past.
    1665|     expect(completed!.payload.output).toEqual({
       |                                       ^
    1666|       schedule_id: 'heartbeat-1m',
    1667|       slot: 29_400_000,

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[9/9]⎯

 Test Files  2 failed (2)
      Tests  8 failed | 23 passed | 14 skipped (45)
   Start at  00:09:29
   Duration  53.91s (transform 730ms, setup 0ms, collect 1.96s, tests 52.75s, environment 0ms, prepare 99ms)


```

</details>

<details>
<summary>d-restored: literal command and captured output</summary>

```text
$ cd kernel && sh ../ops/cargo.sh test -p relayflowd exec_det
   Compiling relayflowd v0.1.0 (/home/daytona/.relayflow-v2-supervisor/durable/repository/kernel/relayflowd)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 5.16s
     Running unittests src/lib.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/relayflowd-f043db0bb3534a16)

running 7 tests
test exec_det::tests::captures_deterministic_output ... ok
test exec_det::tests::failed_command_evidence_survives_completion ... ok
test exec_det::tests::exec_det_keeps_early_failure_in_both_large_streams ... ok
test exec_det::tests::timeout_has_an_explicit_completion_reason ... ok
test exec_det::tests::exec_det_bounds_duplicate_trajectory_evidence_including_json_escaping ... ok
test exec_det::tests::lease_override_bounds_execution_and_preserves_command_timeout ... ok
test exec_det::tests::timeout_kills_the_whole_process_group ... ok

test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 53 filtered out; finished in 0.25s

     Running unittests src/main.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/relayflowd-6e3681176306c99e)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/budget_gate.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/budget_gate-9607ae7c2db11b74)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 10 filtered out; finished in 0.00s

     Running tests/crash_resume.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/crash_resume-d2d102ec3e89b705)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 40 filtered out; finished in 0.00s

     Running tests/daemon_lifecycle.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/daemon_lifecycle-b705da9761b2a254)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 6 filtered out; finished in 0.00s

     Running tests/event_wake.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/event_wake-b98778c1ad4de872)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s

     Running tests/hn_monitor_integration.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/hn_monitor_integration-059c38eb4828898f)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s

     Running tests/input_binding.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/input_binding-4f132e6302508de8)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out; finished in 0.00s

     Running tests/invalid_schema_preflight.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/invalid_schema_preflight-9c08869ea58d283f)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s

     Running tests/memoization.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/memoization-e5537edfeea8b814)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s

     Running tests/memory.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/memory-fe5dbc6738ee15ff)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 5 filtered out; finished in 0.00s

     Running tests/memory_epoch.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/memory_epoch-627e50d1c86c39e4)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s

     Running tests/parallel_driver.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/parallel_driver-7a554ae88aa529f9)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 4 filtered out; finished in 0.00s

     Running tests/placement_pins.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/placement_pins-839e136752b4e5af)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s

     Running tests/placement_routing.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/placement_routing-9cb694324a7d7bf1)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s

     Running tests/routing_diagnostics.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/routing_diagnostics-7807262e1a1167ec)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out; finished in 0.00s

     Running tests/spec_review_routing.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/spec_review_routing-032df51688a72750)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 4 filtered out; finished in 0.00s

     Running tests/subscription_liveness.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/subscription_liveness-c3bbfd58dcafb336)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s

     Running tests/trigger_watcher.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/trigger_watcher-0504d7ed791030e6)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s


Exit code: 0

```

</details>

<details>
<summary>c-capture-restored: literal command and captured output</summary>

```text
$ cd kernel && sh ../ops/cargo.sh test -p relayflowd output_capture
   Compiling relayflowd v0.1.0 (/home/daytona/.relayflow-v2-supervisor/durable/repository/kernel/relayflowd)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 4.79s
     Running unittests src/lib.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/relayflowd-f043db0bb3534a16)

running 5 tests
test output_capture::tests::keeps_early_tap_failure_and_final_summary ... ok
test output_capture::tests::short_and_exact_budget_are_unchanged ... ok
test output_capture::tests::invalid_input_still_respects_the_byte_budget ... ok
test output_capture::tests::one_byte_over_accounts_for_marker_space_too ... ok
test output_capture::tests::cuts_never_split_utf8_and_all_budgets_hold ... ok

test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 54 filtered out; finished in 0.13s

     Running unittests src/main.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/relayflowd-6e3681176306c99e)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/budget_gate.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/budget_gate-9607ae7c2db11b74)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 10 filtered out; finished in 0.00s

     Running tests/crash_resume.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/crash_resume-d2d102ec3e89b705)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 40 filtered out; finished in 0.00s

     Running tests/daemon_lifecycle.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/daemon_lifecycle-b705da9761b2a254)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 6 filtered out; finished in 0.00s

     Running tests/event_wake.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/event_wake-b98778c1ad4de872)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s

     Running tests/hn_monitor_integration.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/hn_monitor_integration-059c38eb4828898f)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s

     Running tests/input_binding.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/input_binding-4f132e6302508de8)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out; finished in 0.00s

     Running tests/invalid_schema_preflight.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/invalid_schema_preflight-9c08869ea58d283f)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s

     Running tests/memoization.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/memoization-e5537edfeea8b814)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s

     Running tests/memory.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/memory-fe5dbc6738ee15ff)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 5 filtered out; finished in 0.00s

     Running tests/memory_epoch.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/memory_epoch-627e50d1c86c39e4)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s

     Running tests/parallel_driver.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/parallel_driver-7a554ae88aa529f9)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 4 filtered out; finished in 0.00s

     Running tests/placement_pins.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/placement_pins-839e136752b4e5af)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s

     Running tests/placement_routing.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/placement_routing-9cb694324a7d7bf1)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s

     Running tests/routing_diagnostics.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/routing_diagnostics-7807262e1a1167ec)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out; finished in 0.00s

     Running tests/spec_review_routing.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/spec_review_routing-032df51688a72750)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 4 filtered out; finished in 0.00s

     Running tests/subscription_liveness.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/subscription_liveness-c3bbfd58dcafb336)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s

     Running tests/trigger_watcher.rs (/home/daytona/.relayflows-toolchain/target/2962130851/debug/deps/trigger_watcher-0504d7ed791030e6)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s


Exit code: 0

```

</details>

<details>
<summary>kernel-final-build: literal command and captured output</summary>

```text
$ cd kernel && sh ../ops/cargo.sh build -p relayflowd
   Compiling relayflowd v0.1.0 (/home/daytona/.relayflow-v2-supervisor/durable/repository/kernel/relayflowd)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.92s

```

</details>

