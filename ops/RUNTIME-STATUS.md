# Runtime status — 2026-09-07

## Result

A relayflow runs locally on this checkout. No Cloud admission, Daytona,
Relaycast workspace, or model provider is needed for deterministic execution.
The local tick executed the real **F8b** item from `ops/BACKLOG.md`: it renamed
`validateKernelRetry` to `validateAuthoringRetryDefaults` at its declaration
and call, without changing the rule. Selection, mutation, existing tests,
and the resulting diff were executed as four journaled deterministic steps.
This is the smallest local equivalent of drive, not a migration of the full
legacy assess/build/review/PR loop. The tick itself does not commit or open a
PR; the operator delivers its recorded diff on this branch. No merge is authorized.

The kernel was already capable of local execution. The immediate setup gap was
no built SDK or local daemon. The legacy drive YAML has a separate format gap:
this SDK refuses its old `swarm`/`workflows` schema before execution.

## Environment and first local failure

The supplied sf-mini binary path was not present in the actual cwd environment.
This work ran on Darwin arm64, with all build/cache locations selected inside
the worktree. The initial disk check before installing/building showed 22 GiB
available; the later captured inventory is [environment.txt](runtime-evidence/environment.txt):

```text
$ pwd
/Users/khaliqgant/AgentWorkforce/flows-runtime-0907-wt
exit=0
$ uname -sm
Darwin arm64
exit=0
$ df -h .
Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on
/dev/disk3s5   228Gi   174Gi    21Gi    90%    4.2M  221M    2%   /System/Volumes/Data
exit=0
$ git branch --show-current
runtime/flows-restore-0907
exit=0
$ git rev-parse HEAD
460c0f7723da0c0fe8d5fffb87f60c058996ca3e
exit=0
$ node --version
v26.7.0
exit=0
$ sh -c 'command -v flows; command -v relayflows'
exit=1
$ sh -c 'ls "$HOME"/.relayflows-toolchain/target/*/debug/relayflowd'
ls: /Users/khaliqgant/.relayflows-toolchain/target/*/debug/relayflowd: No such file or directory
exit=1

```

Built the existing SDK, then attempted:

```sh
node packages/sdk/dist/cli.js run --json testdata/hello-deterministic.flow.yaml
```

Exit 2. First refusal (literal; full stdout/stderr in
[hello-before.txt](runtime-evidence/hello-before.txt)):

```text
REFUSED [daemon_unreachable] No compatible relayflowd is listening at "/Users/khaliqgant/AgentWorkforce/flows-runtime-0907-wt/.relayflowd/relayflowd.sock". Start it with: relayflowd --data-dir ".relayflowd" serve
```

Starting the locally built daemon resolved that refusal. No kernel source was
changed. The standalone kernel command also completed:

```sh
kernel/target/debug/relayflowd --data-dir .relayflowd run testdata/hello-deterministic.spec.canonical.json
```

```text
{"run_id":"01M1YSGGNGHFF10DYQB4WESTG4","status":"completed","completion_reason":"success","completed_steps":2}

```

## Reproduce local hello

Setup commands used on this machine (npm always has the explicit userconfig;
the config path need not exist and was not created outside the worktree):

```sh
mkdir -p .relayflow/tmp
export TMPDIR="$PWD/.relayflow/tmp"
npm_config_cache="$PWD/.relayflow/npm-cache" npm --userconfig /tmp/empty-npmrc ci --ignore-scripts --no-audit --no-fund --prefix packages/sdk
npm_config_cache="$PWD/.relayflow/npm-cache" npm --userconfig /tmp/empty-npmrc run build --prefix packages/sdk
CARGO_HOME="$PWD/.cargo-home" CARGO_TARGET_DIR="$PWD/kernel/target" RUSTC="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc" "$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo" build --manifest-path kernel/Cargo.toml --locked
```

The Rust command reads the installed compiler and writes build/cache files here.
On another host use its installed cargo/rustc or set `RELAYFLOWD_BIN` to an
existing binary; the launcher defaults to `kernel/target/debug/relayflowd`.
Captured build output: [SDK](runtime-evidence/build-sdk.txt),
[kernel](runtime-evidence/build-kernel.txt).

Run with a clean environment containing only PATH, HOME and a local TMPDIR:

```sh
env -i PATH="$PATH" HOME="$HOME" TMPDIR="$PWD/.relayflow/tmp" node scripts/run-local-workflow.mjs testdata/hello-deterministic.flow.yaml
```

Exit 0. Terminal report (literal full report; the preceding journal records
include `stdout_tail: "hello\n"` and `stdout_tail: "HELLO\n"`):

```json
{"ok":true,"command":"run","path":"testdata/hello-deterministic.flow.yaml","projectConfigPath":"/Users/khaliqgant/AgentWorkforce/flows-runtime-0907-wt/testdata/flows.json","resolutions":[],"diagnostics":[{"severity":"warning","kind":"unprovable_effects","stepId":"greet","message":"Step \"greet\" command \"echo\" resolves, but its effects cannot be proven before execution."},{"severity":"warning","kind":"unprovable_effects","stepId":"shout","message":"Step \"shout\" command \"echo\" resolves, but its effects cannot be proven before execution."}],"runId":"01M1YT6CC37S7MVDXXTNEZRT8Z","socketPath":"/Users/khaliqgant/AgentWorkforce/flows-runtime-0907-wt/.relayflow/local-ydugI4/relayflowd.sock","status":"completed","completionReason":"success","completedSteps":2}
```

Full command output: [hello-clean-env.txt](runtime-evidence/hello-clean-env.txt).
This clears ambient Cloud/Relaycast credentials; it is not a network packet
capture. The executed commands are the checked-in `echo` steps.

## Which workflows need Cloud?

[workflows/README.md](../workflows/README.md) records the per-file dependency
matrix. The distinction is engine dialect versus deployment location:

- `drive-local.yaml`: local deterministic work; no service call at runtime.
- `preswarm-check.yaml`: local kernel, but nested Claude/Codex/OpenCode reviewers
  require their provider authentication. No Cloud admission or Daytona.
- `drive.yaml`: legacy engine; authored for local checkout or cloud snapshot.
  PR delivery needs GitHub or the cloud proxy. Its sync step changes branches,
  so it was not executed over this active worktree.
- `drive-cloud.yaml`: legacy, generated Cloud/artifact-delivery variant.
- `bootstrap-gate1.yaml`: legacy bootstrap; could be locally placed with its
  toolchains and authenticated model CLIs. It mutates the engine source.
- `review-swarm.yaml`: legacy; CI currently places it in Cloud. A local legacy
  execution would also need staged review inputs and three authenticated CLIs.
- `watchdog.yaml`: explicitly reads Cloud schedules, plus GitHub/model/Relaycast.

For every existing top-level YAML the literal `flows check` command, exit code,
and full stdout/stderr are in [workflow-checks.txt](runtime-evidence/workflow-checks.txt).
The five legacy YAMLs all returned exit 2, first diagnostic:

```text
REFUSED [invalid_spec] Relayflow spec is invalid: spec: unknown key "swarm" (expected one of version | name | description | cli | agents | triggers | steps | budget); spec: unknown key "workflows" (expected one of version | name | description | cli | agents | triggers | steps | budget); spec.version: unsupported version "1.0" (expected "0.1.0"); spec.agents: expected a map of named { cli, model } declarations; spec.steps: expected a non-empty array
```

`preswarm-check.yaml` returned exit 0 with warnings. This is compilation and
preflight evidence, not a completed review. The later
[workflow-summary.txt](runtime-evidence/workflow-summary.txt) also includes the
new local drive spec. No legacy `relayflows` executable was installed here.
Its runtime behavior was not tested or inferred from a successful v2 check.

## Work package execution and delivery

Scaffold commit: `89f2f1d31f262420c2c5f613efa3f50c70153bfa`.
From a clean work branch at that commit, after the setup above:

```sh
node scripts/run-local-workflow.mjs workflows/drive-local.yaml
```

Exit 0. Full report:

```json
{"ok":true,"command":"run","path":"workflows/drive-local.yaml","resolutions":[],"diagnostics":[{"severity":"warning","kind":"unprovable_effects","stepId":"select-package","message":"Step \"select-package\" command \"node\" resolves, but its effects cannot be proven before execution."},{"severity":"warning","kind":"unprovable_effects","stepId":"implement-package","message":"Step \"implement-package\" command \"node\" resolves, but its effects cannot be proven before execution."},{"severity":"warning","kind":"command_unresolved","stepId":"verify-package","message":"Step \"verify-package\" command \"set\" does not resolve as an executable; it runs only if the shell supplies it."},{"severity":"warning","kind":"unprovable_effects","stepId":"report-package","message":"Step \"report-package\" command \"node\" resolves, but its effects cannot be proven before execution."}],"runId":"01M1YT3XA5QB7GYRGY2MH2HG7T","socketPath":"/Users/khaliqgant/AgentWorkforce/flows-runtime-0907-wt/.relayflow/local-J50W0n/relayflowd.sock","status":"completed","completionReason":"success","completedSteps":4}
```

The `implement-package` step captured this mutation receipt:

```text
PACKAGE_APPLIED: F8b 5840c31f95d1446cbbd8e523073176abb3c2fffd684864cb4fdeb2932709865d -> 92d08a43a14c1406b2238259513fda0906da276470b24f76270b0f5ed863aa93
```

It asserted the file changed and re-read its SHA-256 before returning success.
The actual two-line rename is [f8b.diff](runtime-evidence/f8b.diff).
The new name describes the SDK's authoring-default restriction; the existing
error text and kernel retry behavior are unchanged.

The next step ran these existing commands, without editing their tests:

```sh
set -eu
npm_config_cache="$PWD/.relayflow/npm-cache" npm --userconfig /tmp/empty-npmrc run build --prefix packages/sdk
cd packages/sdk
node node_modules/vitest/vitest.mjs run tests/spec-parity.test.ts tests/cli.test.ts
```

Literal stdout/stderr:

```text

> @relayflows/sdk@2.0.1 build
> tsc && node scripts/make-cli-executable.mjs


 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-runtime-0907-wt/packages/sdk

 ✓ tests/spec-parity.test.ts (28 tests) 160ms
 ✓ tests/cli.test.ts (63 tests) 2386ms
   ✓ flows check CLI > binds a checked relative wrapper to the flow directory for worker execution 380ms
   ✓ flows check CLI > resolves a project CLI path relative to the flows.json that declares it 310ms

 Test Files  2 passed (2)
      Tests  91 passed (91)
   Start at  22:49:22
   Duration  2.79s (transform 168ms, setup 0ms, collect 402ms, tests 2.55s, environment 0ms, prepare 75ms)


```

The full run is [drive-local.txt](runtime-evidence/drive-local.txt); the ten raw
journal entries are also exported in
[drive-local.journal.jsonl](runtime-evidence/drive-local.journal.jsonl).
The SQLite record remains in the printed `LOCAL_DATA_DIR` in this worktree.
The package file, source hashes and diff appear in the journal itself.

There were two successful F8b ticks. The first output is retained in
[drive-local-first.txt](runtime-evidence/drive-local-first.txt). Before the final
run, only its known two-line source change was restored byte-for-byte to the
scaffold commit, asserting both hashes; the reset receipt is
[reset-package-for-final-run.txt](runtime-evidence/reset-package-for-final-run.txt).
This is **not** a mutation-verification claim. On the final delivered head a
new F8b tick intentionally refuses because the package is already applied;
use the scaffold commit for reproduction, or hello for a repeatable smoke run.

## Launcher checks and failures found while implementing it

```sh
node --test scripts/run-local-workflow.test.mjs
```

Final literal output:

```text
✔ local launcher journals deterministic effects and reads more than one journal page (537.042792ms)
✔ a failed command fails the run and prevents dependent effects (127.248833ms)
✔ the SDK worker completes an agent step through the local journal protocol (541.697084ms)
✔ missing daemon is refused before a data directory or run is created (59.212417ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1305.905833

```

These checks exercise a 51-step run (journal pagination), a command exiting 7
whose dependent file write must not happen, SDK `AgentWorker` dispatch through
a deterministic wrapper, and refusal before submission when the binary is absent.
They do not call a model provider.

The first implementation left a stale socket after daemon exit. Its first
four-test run failed three socket-cleanup assertions; captured in
[launcher-tests-first.txt](runtime-evidence/launcher-tests-first.txt).
Cleanup now waits for the owned daemon to exit before unlinking its socket.
The next run exposed two separate facts:

```text
TypeError: Cannot read properties of null (reading 'exit_code')
bad_request: an agent worker must attach with the pins of the surfaces it holds
```

Full output: [launcher-tests-second.txt](runtime-evidence/launcher-tests-second.txt).
The failure assertion was corrected to check the kernel's recorded verification
verdict/detail (`exit code was 7`); failed outputs are null. The launcher now
pins declared streams at offset 0 in its fresh cell. It refuses workspace or
external surfaces instead of manufacturing revisions; an agent flow with no
stream pins is refused before creating a run. No kernel admission rule changed.

## Existing crash/resume gate

```sh
CARGO_HOME="$PWD/.cargo-home" CARGO_TARGET_DIR="$PWD/kernel/target" RUSTC="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc" "$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo" test --manifest-path kernel/Cargo.toml --locked -p relayflowd --test crash_resume
```

Captured output (full build/test output in
[crash-resume.txt](runtime-evidence/crash-resume.txt)):

```text
running 37 tests
test agent::resume_without_a_worker_parks_immediately_instead_of_timing_out ... ok
test channels::channels_reject_foreign_workers_stale_attempts_and_invalid_acknowledgements ... ok
test concurrency::cancel_closes_the_lease_and_rejects_a_late_completion ... ok
test agent::rung_c_sigkill_after_final_effect_replays_results_without_redispatch ... ok
test concurrency::cancel_and_completion_race_has_one_terminal_fact ... ok
test agent::rung_c_sigkill_between_agent_completion_and_final_effect_memoizes_the_agent ... ok
test concurrency::run_start_dispatches_every_independent_lane_before_any_completion ... ok
test concurrency::concurrent_resumes_lease_exactly_one_attempt ... ok
test concurrency::live_resume_leaves_an_active_lease_running ... ok
test agent::rung_c_crash_between_effect_election_and_the_provider_call_performs_it_exactly_once ... ok
test agent::rung_c_reset_sigkill_mid_edit_restores_pins_dedupes_effect_and_explains_attempts ... ok
test llm::serve_plumbs_watch_events_and_replayable_stream_verbs ... ok
test llm::failing_llm_verification_schedules_a_durable_retry_and_succeeds ... ok
test llm::completed_llm_output_is_memoized_when_serve_dies_during_the_next_step ... ok
test llm::llm_verification_exhaustion_is_a_declared_failure_kind ... ok
test llm::sigkill_after_the_final_rung_b_effect_resumes_without_redispatching_llm ... ok
test concurrency::server_restart_recovers_every_parallel_lease_without_duplicate_success ... ok
test agent::rung_c_sigkill_boundaries_resume_only_unfinished_steps_via_real_cli ... ok
test llm::sigkill_under_serve_mid_llm_releases_the_lease_and_finishes_via_cli_resume ... ok
test pin_projection::rejected_completion_cannot_forge_inspect_retry_pins_over_the_real_socket ... ok
test llm::sigkill_sweep_covers_before_and_between_the_rung_b_steps ... ok
test protocol_admission::every_mutating_run_verb_refuses_terminal_before_changing_state ... ok
test sigkill_after_cancel_request_resumes_to_one_canceled_fact ... ok
test llm::worker_killed_while_holding_a_lease_is_explained_and_released_on_cli_resume ... ok
test memory::memory_sigkill_after_injection_replays_pack_and_charges_it_once ... ok
test sigkill_mid_step_replaces_and_explains_the_dead_attempt ... ok
test parallel_lifecycle::overlapping_agent_lanes_serialize_while_disjoint_lanes_merge_in_either_order ... ok
test parallel_lifecycle::overlapping_agent_conflict_survives_server_crash_and_resume ... ok
test parallel_lifecycle::terminal_failure_drains_or_explains_every_live_sibling ... ok
test surface_identity::aliases_are_rejected_and_external_ancestors_serialize_over_real_sockets ... ok
test workspace_identity::workspace_aliases_are_refused_and_canonical_subtrees_serialize_over_real_sockets ... ok
test worker_capacity::two_workers_receive_a_deterministic_fair_capacity_bounded_batch ... ok
test sigkill_under_serve_resumes_the_socket_started_run ... ok
test worker_capacity::default_capacity_one_reopens_only_after_durable_completion_or_crash ... ok
test sigkill_sweep_covers_every_hello_step_boundary ... ok
test channels::channels_sigkill_resume_redelivers_unacked_messages_with_exactly_once_effects ... ok
test parallel_lifecycle::renewed_parallel_leases_survive_the_original_grant_and_remain_distinct ... ok

test result: ok. 37 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 37.91s


```

## Limits and remaining work

- The delivered work package is deterministic and bounded. Autonomous agent
  implementation/review/PR delivery from the old `drive.yaml` is not restored.
- The launcher serves stream-only agent work with the existing SDK worker. It
  does not implement workspace revision/reset, mount effects, worker heartbeats,
  filesystem isolation, or a bare-LLM worker. Model-backed execution was not
  attempted. These limits are named rather than hidden behind successful hello.
- Local CLI auth and the previous runner are separate from local kernel health.
  Nested deterministic shell commands still have unprovable effects; preflight
  warns about them. No claim of complete offline preflight or provider readiness.
- Broker-supplied Cloud facts were accepted, not re-probed: production v2
  admission disabled; preview v1 bootstrap/Relaycast-repair transient failures;
  wrong-database CI API key returning 401, with cloud#3430 owning the fix.
  No Cloud credentials, Cloud source, admission settings, CI gates, legacy
  workflows, backlog ledger, or merge authority were changed here.

## Source whitespace check

`git diff --cached --check` returned exit 2 for whitespace already present in
literal captured stdout and in the captured unified diff; it is preserved as
raw evidence. The complete output is
[raw-evidence-whitespace.txt](runtime-evidence/raw-evidence-whitespace.txt).
Literal diagnostic lines (the raw file also contains the whitespace itself):

```text
ops/runtime-evidence/build-sdk.txt:4: new blank line at EOF.
ops/runtime-evidence/crash-resume.txt:59: new blank line at EOF.
ops/runtime-evidence/drive-verify.txt:17: new blank line at EOF.
ops/runtime-evidence/f8b.diff:17: trailing whitespace.
ops/runtime-evidence/launcher-tests-second.txt:30: trailing whitespace.
ops/runtime-evidence/launcher-tests-second.txt:31: trailing whitespace.
ops/runtime-evidence/launcher-tests-second.txt:33: trailing whitespace.
ops/runtime-evidence/workflow-checks.txt:32: new blank line at EOF.
```

The source/documentation-only check excludes those literal transcripts:
`git diff --cached --check -- . ':!ops/runtime-evidence/**'` (exit 0, no output).

## Delivery

PR: https://github.com/AgentWorkforce/flows/pull/231 (human review/merge).
Branch: `runtime/flows-restore-0907`.

- `89f2f1d31f262420c2c5f613efa3f50c70153bfa`: local runner and package scaffold.
- `77a60be`: flow-produced F8b source change and captured runtime evidence.

The PR is open; no merge, CI-green claim, or independent signoff is recorded.
