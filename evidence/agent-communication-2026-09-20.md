# Opt-in managed agent communication: captured evidence

The implementation uses the existing Relay broker and Relaycast delivery. No kernel or review gate changes.

Happy-path run: `01M2YV83N7XQ714PB2JH135W64`. Final crash/resume run: `01M2YVKP3PMW1007M28N2DARVP`. The crash is after delivery and before any processing acknowledgement. Exactly-once below refers to channel appends, not model execution or arbitrary external effects.

## managed-communication-build-final.txt

```text
cwd: /tmp/flows-relay-communication
$ npm --prefix packages/sdk run build

> @relayflows/sdk@2.0.22 build
> tsc && node scripts/make-cli-executable.mjs


exit status: 0
```

## managed-communication-typecheck-final.txt

```text
cwd: /tmp/flows-relay-communication
$ npm --prefix packages/sdk run typecheck

> @relayflows/sdk@2.0.22 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json


exit status: 0
```

## managed-communication-tests-final.txt

```text
cwd: /tmp/flows-relay-communication/packages/sdk
$ env RELAYFLOWD_BIN=/tmp/flows-pr-cleanup/pr499/kernel/target/debug/relayflowd ./node_modules/.bin/vitest run tests/communication.test.ts tests/communication-tools.test.ts tests/communication-lazy.test.ts tests/communication-history.test.ts tests/communication-worker.test.ts tests/worker-lease.test.ts tests/yaml-local-agent-live.test.ts tests/journal-client.test.ts tests/spec-parity.test.ts

 RUN  v2.1.9 /tmp/flows-relay-communication/packages/sdk

 ✓ tests/communication-history.test.ts (1 test) 5ms
 ✓ tests/communication-tools.test.ts (1 test) 54ms
 ✓ tests/communication-worker.test.ts (2 tests) 109ms
 ✓ tests/communication.test.ts (9 tests) 14ms
 ✓ tests/journal-client.test.ts (15 tests) 80ms
 ✓ tests/communication-lazy.test.ts (1 test) 4ms
 ✓ tests/worker-lease.test.ts (7 tests) 13ms
 ✓ tests/spec-parity.test.ts (31 tests) 297ms
 ✓ tests/yaml-local-agent-live.test.ts (7 tests) 2867ms
   ✓ YAML --local-agent through the built CLI and real daemon > runs with the checked step CLI and model and journals done 504ms
   ✓ YAML --local-agent through the built CLI and real daemon > runs with the checked named CLI and model and journals done 367ms
   ✓ YAML --local-agent through the built CLI and real daemon > runs with the checked flow CLI and model and journals done 444ms
   ✓ YAML --local-agent through the built CLI and real daemon > runs with the checked project CLI and model and journals done 451ms
   ✓ YAML --local-agent through the built CLI and real daemon > still parks without --local-agent 330ms
   ✓ YAML --local-agent through the built CLI and real daemon > reports the agent process failure 373ms
   ✓ YAML --local-agent through the built CLI and real daemon > preserves declared workspace surfaces that the local worker cannot pin 397ms

 Test Files  9 passed (9)
      Tests  74 passed (74)
   Start at  00:31:06
   Duration  3.21s (transform 871ms, setup 0ms, collect 2.79s, tests 3.44s, environment 2ms, prepare 616ms)


exit status: 0
```

## managed-communication-recovery-tests.txt

```text
cwd: /tmp/flows-relay-communication
$ packages/sdk/node_modules/.bin/vitest run packages/sdk/tests/communication.test.ts packages/sdk/tests/communication-history.test.ts

 RUN  v2.1.9 /tmp/flows-relay-communication

 ✓ packages/sdk/tests/communication-history.test.ts (1 test) 3ms
 ✓ packages/sdk/tests/communication.test.ts (10 tests) 13ms

 Test Files  2 passed (2)
      Tests  11 passed (11)
   Start at  00:31:56
   Duration  455ms (transform 151ms, setup 0ms, collect 290ms, tests 16ms, environment 0ms, prepare 110ms)


exit status: 0
```

## managed-communication-channel-crash-tests.txt

```text
cwd: /tmp/flows-relay-communication/kernel
$ env CARGO_TARGET_DIR=/tmp/flows-pr-cleanup/pr499/kernel/target sh ../ops/cargo.sh test -p relayflowd --test crash_resume channels_ -- --nocapture
 Downloading crates ...
  Downloaded errno v0.3.14
  Downloaded fastrand v2.5.0
  Downloaded tempfile v3.27.0
  Downloaded getrandom v0.4.3
  Downloaded rustix v1.1.4
  Downloaded linux-raw-sys v0.12.1
   Compiling proc-macro2 v1.0.107
   Compiling quote v1.0.47
   Compiling unicode-ident v1.0.24
   Compiling libc v0.2.189
   Compiling stable_deref_trait v1.2.1
   Compiling cfg-if v1.0.4
   Compiling version_check v0.9.5
   Compiling autocfg v1.5.1
   Compiling serde_core v1.0.229
   Compiling zerocopy v0.8.56
   Compiling getrandom v0.3.4
   Compiling serde v1.0.229
   Compiling smallvec v1.15.2
   Compiling writeable v0.6.4
   Compiling litemap v0.8.3
   Compiling memchr v2.8.3
   Compiling icu_normalizer_data v2.3.0
   Compiling icu_properties_data v2.3.0
   Compiling utf8_iter v1.0.4
   Compiling ref-cast v1.0.27
   Compiling parking_lot_core v0.9.12
   Compiling zmij v1.0.23
   Compiling typenum v1.20.1
   Compiling scopeguard v1.2.0
   Compiling once_cell v1.21.4
   Compiling find-msvc-tools v0.1.11
   Compiling regex-syntax v0.8.11
   Compiling serde_json v1.0.151
   Compiling shlex v2.0.1
   Compiling lock_api v0.4.14
   Compiling itoa v1.0.18
   Compiling borrow-or-share v0.2.4
   Compiling pkg-config v0.3.34
   Compiling bit-vec v0.8.0
   Compiling vcpkg v0.2.15
   Compiling uuid v1.26.0
   Compiling percent-encoding v2.3.2
   Compiling utf8parse v0.2.2
   Compiling bitflags v2.13.1
   Compiling foldhash v0.1.5
   Compiling thiserror v2.0.20
   Compiling generic-array v0.14.7
   Compiling ahash v0.8.12
   Compiling cc v1.4.4
   Compiling outref v0.5.2
   Compiling lazy_static v1.5.0
   Compiling vsimd v0.8.0
   Compiling bit-set v0.8.0
   Compiling hashbrown v0.15.5
   Compiling anstyle-parse v1.0.0
   Compiling cpufeatures v0.2.17
   Compiling num-traits v0.2.19
   Compiling anstyle-query v1.1.5
   Compiling base64 v0.22.1
   Compiling num-cmp v0.1.0
   Compiling is_terminal_polyfill v1.70.2
   Compiling bytecount v0.6.9
   Compiling anstyle v1.0.14
   Compiling colorchoice v1.0.5
   Compiling anyhow v1.0.104
   Compiling strsim v0.11.1
   Compiling fallible-streaming-iterator v0.1.9
   Compiling clap_lex v1.1.0
   Compiling heck v0.5.0
   Compiling ryu-js v1.0.3
   Compiling fallible-iterator v0.3.0
   Compiling rustix v1.1.4
   Compiling getrandom v0.4.3
   Compiling anstream v1.0.0
   Compiling aho-corasick v1.1.5
   Compiling linux-raw-sys v0.12.1
   Compiling fastrand v2.5.0
   Compiling uuid-simd v0.8.0
   Compiling clap_builder v4.6.6
   Compiling hashlink v0.10.0
   Compiling syn v3.0.4
   Compiling syn v2.0.119
   Compiling num-integer v0.1.47
   Compiling num-complex v0.4.6
   Compiling wait-timeout v0.2.1
   Compiling block-buffer v0.10.4
   Compiling crypto-common v0.1.7
   Compiling libsqlite3-sys v0.35.0
   Compiling num-bigint v0.4.8
   Compiling num-iter v0.1.46
   Compiling rand_core v0.9.5
   Compiling digest v0.10.7
   Compiling parking_lot v0.12.5
   Compiling sha2 v0.10.9
   Compiling regex-automata v0.4.18
   Compiling num-rational v0.4.2
   Compiling synstructure v0.13.2
   Compiling num v0.4.3
   Compiling fraction v0.15.4
   Compiling tempfile v3.27.0
   Compiling zerofrom-derive v0.1.7
   Compiling yoke-derive v0.8.2
   Compiling ppv-lite86 v0.2.21
   Compiling rand_chacha v0.9.0
   Compiling zerofrom v0.1.8
   Compiling zerovec-derive v0.11.6
   Compiling displaydoc v0.2.7
   Compiling serde_derive v1.0.229
   Compiling ref-cast-impl v1.0.27
   Compiling thiserror-impl v2.0.20
   Compiling clap_derive v4.6.4
   Compiling rand v0.9.5
   Compiling yoke v0.8.3
   Compiling zerotrie v0.2.5
   Compiling zerovec v0.11.8
   Compiling clap v4.6.6
   Compiling tinystr v0.8.4
   Compiling potential_utf v0.1.6
   Compiling icu_collections v2.3.0
   Compiling regex v1.13.1
   Compiling fancy-regex v0.16.2
   Compiling icu_locale_core v2.3.0
   Compiling icu_provider v2.3.1
   Compiling fluent-uri v0.3.2
   Compiling email_address v0.2.9
   Compiling ulid v1.2.1
   Compiling icu_properties v2.3.0
   Compiling icu_normalizer v2.3.0
   Compiling referencing v0.33.0
   Compiling idna_adapter v1.2.2
   Compiling idna v1.1.0
   Compiling jsonschema v0.33.0
   Compiling relayflowd-core v0.1.0 (/tmp/flows-relay-communication/kernel/relayflowd-core)
   Compiling rusqlite v0.37.0
   Compiling relayflowd-journal v0.1.0 (/tmp/flows-relay-communication/kernel/relayflowd-journal)
   Compiling relayflowd v0.1.0 (/tmp/flows-relay-communication/kernel/relayflowd)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 12.94s
     Running tests/crash_resume.rs (/tmp/flows-pr-cleanup/pr499/kernel/target/debug/deps/crash_resume-d2d102ec3e89b705)

running 2 tests
test channels::channels_reject_foreign_workers_stale_attempts_and_invalid_acknowledgements ... ok
test channels::channels_sigkill_resume_redelivers_unacked_messages_with_exactly_once_effects ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 38 filtered out; finished in 0.47s


exit status: 0
```

## managed-communication-verification.txt

```text
cwd: /tmp/flows-relay-communication
$ python scripts/verify-agent-communication.py /tmp/flows-relay-live/data-3/runs/01M2YV83N7XQ714PB2JH135W64.sqlite3
{
  "run_id": "01M2YV83N7XQ714PB2JH135W64",
  "appends": 4,
  "deliveries": 4,
  "processing_acks": 4,
  "successful_agents": 2,
  "injection_receipts": 6,
  "completionReason": "success"
}

exit status: 0
```

## managed-communication-live-crash-2.txt

```text
cwd: /tmp/flows-relay-communication
$ node /tmp/flows-relay-live/crash-2.mjs
SIGKILL daemon after durable delivery, before acknowledgement; run 01M2YVKP3PMW1007M28N2DARVP
acknowledgements at crash: 0
first invocation {"code":1,"signal":null,"stdout":"{\"ok\":false,\"command\":\"run\",\"path\":\"/tmp/flows-relay-live/crash-flow.json\",\"resolutions\":[{\"stepId\":\"sender\",\"cli\":\"claude\",\"source\":\"flow\",\"model\":\"claude-opus-5\",\"modelSource\":\"adapter\"},{\"stepId\":\"receiver\",\"cli\":\"claude\",\"source\":\"flow\",\"model\":\"claude-opus-5\",\"modelSource\":\"adapter\"}],\"diagnostics\":[{\"severity\":\"warning\",\"kind\":\"budget_unmetered\",\"message\":\"Managed communication sessions do not report token or dollar usage. Budget ceilings cannot bound their spend; communication.timeoutMs bounds their duration.\"},{\"severity\":\"failure\",\"kind\":\"protocol_error\",\"message\":\"relayflowd could not complete the run request: journal client: not connected (run.get)\"}],\"socketPath\":\"/run/user/1000/relayflowd-6ecae5c6dcc1.sock\"}\n","stderr":"WAITING [worker_lease] Run \"01M2YVKP3PMW1007M28N2DARVP\" step \"receiver\" (agent) is running under a worker lease until 1789889498541.\nWAITING [worker_lease] Run \"01M2YVKP3PMW1007M28N2DARVP\" step \"receiver\" (agent) is running under a worker lease until 1789889508555.\nWAITING [worker_lease] Run \"01M2YVKP3PMW1007M28N2DARVP\" step \"receiver\" (agent) is running under a worker lease until 1789889518556.\nWAITING [worker_lease] Run \"01M2YVKP3PMW1007M28N2DARVP\" step \"receiver\" (agent) is running under a worker lease until 1789889528557.\nWARNING [budget_unmetered] Managed communication sessions do not report token or dollar usage. Budget ceilings cannot bound their spend; communication.timeoutMs bounds their duration.\nFAILED [protocol_error] relayflowd could not complete the run request: journal client: not connected (run.get)\n"}
resumed invocation {"code":0,"signal":null,"stdout":"{\"ok\":true,\"command\":\"resume\",\"resolutions\":[],\"diagnostics\":[],\"runId\":\"01M2YVKP3PMW1007M28N2DARVP\",\"socketPath\":\"/run/user/1000/relayflowd-6ecae5c6dcc1.sock\",\"status\":\"completed\",\"completionReason\":\"success\",\"completedSteps\":2}\n","stderr":"WAITING [worker_lease] Run \"01M2YVKP3PMW1007M28N2DARVP\" step \"receiver\" (agent) is running under a worker lease until 1789889545320.\nWAITING [worker_lease] Run \"01M2YVKP3PMW1007M28N2DARVP\" step \"receiver\" (agent) is running under a worker lease until 1789889545324.\nWAITING [worker_lease] Run \"01M2YVKP3PMW1007M28N2DARVP\" step \"receiver\" (agent) is running under a worker lease until 1789889555331.\nWAITING [worker_lease] Run \"01M2YVKP3PMW1007M28N2DARVP\" step \"receiver\" (agent) is running under a worker lease until 1789889565332.\nWAITING [worker_lease] Run \"01M2YVKP3PMW1007M28N2DARVP\" step \"receiver\" (agent) is running under a worker lease until 1789889575334.\nWAITING [worker_lease] Run \"01M2YVKP3PMW1007M28N2DARVP\" step \"receiver\" (agent) is running under a worker lease until 1789889585336.\nWAITING [worker_lease] Run \"01M2YVKP3PMW1007M28N2DARVP\" step \"receiver\" (agent) is running under a worker lease until 1789889595338.\nWAITING [worker_lease] Run \"01M2YVKP3PMW1007M28N2DARVP\" step \"receiver\" (agent) is running under a worker lease until 1789889605339.\nWAITING [worker_lease] Run \"01M2YVKP3PMW1007M28N2DARVP\" step \"sender\" (agent) is running under a worker lease until 1789889605332.\nWAITING [worker_lease] Run \"01M2YVKP3PMW1007M28N2DARVP\" step \"sender\" (agent) is running under a worker lease until 1789889615333.\n"}
{"run_id": "01M2YVKP3PMW1007M28N2DARVP", "appends": 2, "acks": 2, "attempts": 4, "duplicate_appends": 0}


exit status: 0
```

Earlier experiments exposed an identity-release failure (fixed with generation-scoped owned identity deletion) and a stale delivery ID in retry context (fixed by restoring sent/processed messages, leaving unacknowledged messages for fresh injection). The original raw transcripts and SQLite backups remain in the local close-loop evidence directory; none were overwritten.

Scope: local Claude, stream surfaces, optional Relay >=12.3.1 packages (or the sibling workspace builds used here). Interactive usage is explicitly unmetered. Hosted execution, other CLIs, and the public TypeScript channel API are outside this change.

## Test typecheck

```text
cwd: /tmp/flows-relay-communication
$ npm --prefix packages/sdk run typecheck:tests

> @relayflows/sdk@2.0.22 typecheck:tests
> tsc -p tsconfig.tests.json


exit status: 0
```
