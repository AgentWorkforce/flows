# PR 137 structural signoff — 2026-09-02 21:45

- **Verdict:** **FINDINGS**
- **Reviewed head:** `bdd598c05d3172fd2fab6e3ec7009135ebdc2543`
- **Comparison base:** `origin/main` (`a0d42ff`)
- **Scope:** production parallel dispatch, capacity fairness, durable release and crash recovery, terminal refusal, canonical surface identity, lease projection, and v1 protocol compatibility.

## F1 — rejected completion can forge the next `inspect` attempt's starting state (P1)

`step.complete` applies the caller-provided `end_pins` to the hub's live worker projection before `complete_out_of_band` validates the completion. A completion whose reported `started_pins` disagree with its journaled pins is correctly converted to a durable `worker_error`, but the unvalidated end pin has already mutated the projection. `inspect` recovery then selects `last_end_pins`; because the projection was also advanced, the retry passes the pin-mismatch guard and is dispatched at the forged revision.

This violates RFC-0001 Appendix A rules 2, 4 (`inspect` starts in the actual dirty workspace), and 6: a failed/rejected completion cannot be permitted to define the next step's starting state. It also violates the repository's fail-closed rule: the kernel accepts a state change it has rejected as invalid evidence.

Relevant source evidence, captured verbatim:

```text
$ nl -ba kernel/relayflowd/src/server.rs | sed -n '252,292p'; nl -ba kernel/relayflowd/src/engine/remote.rs | sed -n '272,296p'; nl -ba kernel/relayflowd-core/src/machine.rs | sed -n '210,240p'
   252                ));
   253            }
   254            let key = (
   255                params.run_id.clone(),
   256                params.step_id.clone(),
   257                params.attempt,
   258            );
   259            let lock = hub.run_lock(&params.run_id);
   260            let _guard = lock.lock().expect("run lock");
   261            ensure_mutable(&engine, &params.run_id)?;
   262            let worker_id = hub
   263                .completion_worker(connection_id, &key)
   264                .map_err(protocol_conflict)?;
   265            // The worker moved the surfaces its completion pins; the hub's view
   266            // of what it holds moves with it *before* the completion drives the
   267            // run, so the next attempt's chained pins are checked against the
   268            // worker's real state rather than its attach snapshot.
   269            if let Some(end_pins) = &params.end_pins {
   270                hub.advance_worker_pins(connection_id, end_pins);
   271            }
   272            let outcome = engine
   273                .complete_out_of_band(
   274                    &params.run_id,
   275                    &params.step_id,
   276                    OutOfBandCompletion {
   277                        attempt: params.attempt,
   278                        idempotency_key: params.idempotency_key,
   279                        completion_reason: params.completion_reason,
   280                        output: params.output,
   281                        budget: params.usage,
   282                        completed_by: worker_id,
   283                        started_pins: params.started_pins,
   284                        end_pins: params.end_pins,
   285                        effects: params.effects,
   286                        trajectory_tail: params.trajectory_tail,
   287                    },
   288                )
   289                .map_err(internal_error)?;
   290            hub.finish(&key);
   291            if let Some(deadline) = hub.earliest_lease_deadline(&params.run_id) {
   292                engine
   272        unconfirmed: &[String],
   273    ) -> Result<()> {
   274        reject_unconfirmed_elections(completion, unconfirmed)?;
   275        let expected_start = runtime
   276            .last_start_pins
   277            .as_ref()
   278            .context("agent attempt has no journaled start pins")?;
   279        let reported_start = completion
   280            .started_pins
   281            .as_ref()
   282            .context("agent completion omitted started_pins")?;
   283        if reported_start != expected_start {
   284            bail!("agent reported starting from pins other than its journaled pin")
   285        }
   286        if let Some(end_pins) = &completion.end_pins {
   287            validate_agent_pins(step, end_pins)?;
   288        } else if completion.completion_reason == CompletionReason::Success {
   289            bail!("successful agent completion omitted end_pins")
   290        }
   291
   292        let recorded = recorded_effects
   293            .iter()
   294            .map(|effect| {
   295                (
   296                    effect.surface_path.as_str(),
   210                        .streams
   211                        .iter()
   212                        .find(|pin| pin.stream == declared.stream)
   213                        .cloned()
   214                })
   215                .collect(),
   216        }
   217    }
   218
   219    fn start_actions(state: &RunState, step: &StepSpec, attempt: u32, now_ms: i64) -> Vec<Action> {
   220        let key = idempotency_key(&state.run_id, &step.id);
   221        let recovery_mode = match &step.kind {
   222            StepKind::Agent { recovery_mode, .. } => Some(*recovery_mode),
   223            _ => None,
   224        };
   225        let runtime = &state.steps[&step.id];
   226        let (pins, recovery) = match &step.kind {
   227            StepKind::Agent {
   228                recovery_mode,
   229                surfaces,
   230                ..
   231            } => {
   232                let retry_pins = match recovery_mode {
   233                    RecoveryMode::Inspect => runtime
   234                        .last_end_pins
   235                        .as_ref()
   236                        .or(runtime.last_start_pins.as_ref()),
   237                    RecoveryMode::Reset | RecoveryMode::Manual => runtime.last_start_pins.as_ref(),
   238                };
   239                let pins = match retry_pins {
   240                    Some(pins) => pins.clone(),
```

Live Unix-socket reproduction (run at the reviewed head) sent an attempt-1 completion whose `started_pins` deliberately disagreed with its durable start and whose `end_pins` named `forged-revision`. The server journals the rejection as `worker_error` and immediately hands attempt 2 to that same forged revision:

```text
$ node --input-type=module -e '
import net from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
const data = await mkdtemp(join(tmpdir(), "pr137-pin-probe-"));
const server = spawn("kernel/target/debug/relayflowd", ["--data-dir", data, "serve"], {stdio:"ignore"});
const socket = join(data, "relayflowd.sock");
for (let i=0; i<100; i++) { try { await new Promise((ok,no)=>{const s=net.createConnection(socket,()=>{s.destroy();ok();});s.on("error",no);}); break; } catch { await new Promise(r=>setTimeout(r,25)); } }
function peer() { const s=net.createConnection(socket); let b="", next=1; const waiting=[]; const events=[]; s.on("data", c=>{b+=c; for (;;) { const n=b.indexOf("\n"); if(n<0) break; const f=JSON.parse(b.slice(0,n)); b=b.slice(n+1); if(f.event) events.push(f); else { const w=waiting.shift(); if(w) w(f); } }}); return { request(verb,params) { return new Promise(resolve=>{waiting.push(resolve); s.write(JSON.stringify({id:next++,verb,params})+"\n");}); }, event(name) { return new Promise(async resolve=>{for(;;){const i=events.findIndex(e=>e.event===name); if(i>=0)return resolve(events.splice(i,1)[0]); await new Promise(r=>setTimeout(r,5));}}); }, close(){s.destroy();} }; }
const worker=peer(), control=peer();
const attached=await worker.request("worker.attach",{worker_id:"probe",step_types:["agent"],pins:{workspace:[{surface:"repo",revision_id:"rev-0"}]}});
const started=await control.request("run.start",{spec:{steps:[{id:"edit",type:"agent",instruction:"edit",recovery_mode:"inspect",max_iterations:2,retry:{initial_backoff_ms:0,max_backoff_ms:0,multiplier:1,jitter_percent:0},surfaces:{workspace:[{surface:"repo"}]}}]}});
const first=(await worker.event("step.dispatch")).data;
const rejected=await worker.request("step.complete",{run_id:first.run_id,step_id:first.step_id,attempt:first.attempt,idempotency_key:first.idempotency_key,completionReason:"success",output:{ok:true},started_pins:{workspace:[{surface:"repo",revision_id:"not-the-journaled-pin"}]},end_pins:{workspace:[{surface:"repo",revision_id:"forged-revision"}]}});
const second=(await worker.event("step.dispatch")).data;
console.log(JSON.stringify({attached,started:first.run_id===started.result.run_id,first:{attempt:first.attempt,pins:first.pins},rejected:{ok:rejected.ok,status:rejected.result?.status},second:{attempt:second.attempt,pins:second.pins,recovery:second.recovery}},null,2));
worker.close(); control.close(); server.kill();
'
{
  "attached": {
    "id": 1,
    "ok": true,
    "result": {
      "worker_id": "probe"
    }
  },
  "started": true,
  "first": {
    "attempt": 1,
    "pins": {
      "streams": [],
      "workspace": [
        {
          "revision_id": "rev-0",
          "surface": "repo"
        }
      ]
    }
  },
  "rejected": {
    "ok": true,
    "status": "parked"
  },
  "second": {
    "attempt": 2,
    "pins": {
      "streams": [],
      "workspace": [
        {
          "revision_id": "forged-revision",
          "surface": "repo"
        }
      ]
    },
    "recovery": {
      "mode": "inspect",
      "previous_completion_reason": "worker_error",
      "restore_pins": null,
      "trajectory_tail": null
    }
  }
}
```

This is execution evidence, not mutation verification. No production or gate file was edited.

## Checked behavior that remains covered

Capacity fairness and release/crash recovery:

```text
$ cargo test --manifest-path kernel/Cargo.toml -p relayflowd --test crash_resume worker_capacity -- --nocapture
    Finished `test` profile [unoptimized + debuginfo] target(s) in 3.11s
     Running tests/crash_resume.rs (kernel/target/debug/deps/crash_resume-e6635a3f0d48512c)

running 2 tests
test worker_capacity::two_workers_receive_a_deterministic_fair_capacity_bounded_batch ... ok
test worker_capacity::default_capacity_one_reopens_only_after_durable_completion_or_crash ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 27 filtered out; finished in 1.64s
```

Terminal mutation refusal:

```text
$ cargo test --manifest-path kernel/Cargo.toml -p relayflowd --test crash_resume protocol_admission -- --nocapture
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.37s
     Running tests/crash_resume.rs (kernel/target/debug/deps/crash_resume-e6635a3f0d48512c)

running 1 test
test protocol_admission::every_mutating_run_verb_refuses_terminal_before_changing_state ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 28 filtered out; finished in 1.02s
```

Canonical external-surface identity:

```text
$ cargo test --manifest-path kernel/Cargo.toml -p relayflowd --test crash_resume surface_identity -- --nocapture
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.27s
     Running tests/crash_resume.rs (kernel/target/debug/deps/crash_resume-e6635a3f0d48512c)

running 1 test
test surface_identity::aliases_are_rejected_and_external_ancestors_serialize_over_real_sockets ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 28 filtered out; finished in 1.09s
```

## Required remediation and acceptance evidence

Do not advance a worker's pin projection until the completion is validated and durably appended as an accepted state transition. Preserve the ability to dispatch immediately after completion without allowing rejected completion fields to affect worker selection. Add a real-socket regression covering the exact sequence above: bad `started_pins` plus forged `end_pins` on an `inspect` retry must never dispatch at the forged revision. Capture the failing pre-fix and passing post-fix outputs before claiming mutation verification.
