Spec review: original 8bbafca34b6fb15556b67b374da0625dd65d11ea; integrity fixes pushed on this PR branch at 733cf17a216234cc08f284444910a279c4c1553d. BLOCKED: leave open.

P1 — RFC-0001 decision #13 / the explicit vocabulary constraint for this review. `kernel/relayflowd-core/src/entry.rs:28` adds the `step.routed` entry type; `entry.rs:393` adds `epoch.summary.routing`; `spec.rs:348` adds the kernel `requirements` schema, and `kernel/relayflowd/src/worker.rs:19` adds dispatch routing. Gate 7 does require journaled routing evidence, but RFC-0001 does not specify these exact additions or their compatibility contract. This is a blocking specification question, not a naming nit. Khaliq/spec owner must settle the contract explicitly or require lowering through existing facts; I have not amended the spec to approve my work.

P1 — `kernel/relayflowd/src/engine/placement.rs:163` rereads HEAD instead of preserving the source revision across resume. The route persists only a path, so the run can switch source commits between steps and still complete successfully. This contradicts the source continuity required by Gate 7 / Appendix A's pin chain. The remaining correction depends on the agreed durable representation; I did not invent another field to paper over the vocabulary blocker. Literal reproduction (script and output also committed in kernel/evidence/225/spec-review-source-drift-repro.*):
```
$ python3 ops/spec-review-0907-evidence/227-source-drift-repro.py /Users/khaliqgant/AgentWorkforce/flows-225-placement-wt/kernel/target/debug/relayflowd
$ git init -q
exit_code=0
$ git add source.txt
exit_code=0
$ git -c user.name=Fixture -c user.email=fixture@example.test -c commit.gpgsign=false commit -qm original
exit_code=0
$ /Users/khaliqgant/AgentWorkforce/flows-225-placement-wt/kernel/target/debug/relayflowd --data-dir /var/folders/yv/nbp9l2c55wlbj1x0gml37s7c0000gn/T/placement-drift-dsqt865h/data run /var/folders/yv/nbp9l2c55wlbj1x0gml37s7c0000gn/T/placement-drift-dsqt865h/flow.json --stop-after 1
{"run_id":"01M1YXR74Z6RWZMCYJ8HW9SY9S","status":"interrupted","completion_reason":null,"completed_steps":1}
exit_code=0
$ git add source.txt
exit_code=0
$ git -c user.name=Fixture -c user.email=fixture@example.test -c commit.gpgsign=false commit -qm changed
exit_code=0
$ /Users/khaliqgant/AgentWorkforce/flows-225-placement-wt/kernel/target/debug/relayflowd --data-dir /var/folders/yv/nbp9l2c55wlbj1x0gml37s7c0000gn/T/placement-drift-dsqt865h/data resume 01M1YXR74Z6RWZMCYJ8HW9SY9S
{"run_id":"01M1YXR74Z6RWZMCYJ8HW9SY9S","status":"completed","completion_reason":"success","completed_steps":2}
exit_code=0
{"entry_type": "step.attempt.started", "step": "first", "pins": {"streams": [], "workspace": [{"revision_id": "c2df7c0316d15be56f8cb282cd67da83a70c7704", "surface": "/private/var/folders/yv/nbp9l2c55wlbj1x0gml37s7c0000gn/T/placement-drift-dsqt865h/tree"}]}, "output": null}
{"entry_type": "step.completed", "step": "first", "pins": null, "output": {"exit_code": 0, "stderr_tail": "", "stdout_tail": "original\n"}}
{"entry_type": "step.attempt.started", "step": "second", "pins": {"streams": [], "workspace": [{"revision_id": "14f735f5866363a1de0b1fef8faa1200c6d0e7f8", "surface": "/private/var/folders/yv/nbp9l2c55wlbj1x0gml37s7c0000gn/T/placement-drift-dsqt865h/tree"}]}, "output": null}
{"entry_type": "step.completed", "step": "second", "pins": null, "output": {"exit_code": 0, "stderr_tail": "", "stdout_tail": "changed-between-steps\n"}}

exit_code=0
```

Integrity fixes made without further vocabulary additions:
- `kernel/relayflowd-core/src/state/routing.rs:8`: reject attempt-scoped routing entries during replay, matching journal admission.
- `kernel/relayflowd-journal/src/placement.rs:47`: validate raw epoch routing before commit, including unknown steps/malformed decisions and attempts to drop or replace durable routes.
- `kernel/relayflowd/src/workspace.rs:11`: peel HEAD with `HEAD^{commit}` and refuse non-commit objects.

Four focused regressions failed before these fixes and passed after. Complete literal before/after commands and outputs are committed in `kernel/evidence/225/spec-review-regressions-before.txt` and `spec-review-regressions-after.txt`. This is not labeled mutation verification. After-fix captured output:
```
$ env RUSTC=/Users/khaliqgant/.rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc /Users/khaliqgant/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo test --manifest-path kernel/Cargo.toml --locked --offline --test spec_review_routing
   Compiling relayflowd-core v0.1.0 (/Users/khaliqgant/AgentWorkforce/flows-225-placement-wt/kernel/relayflowd-core)
   Compiling relayflowd-journal v0.1.0 (/Users/khaliqgant/AgentWorkforce/flows-225-placement-wt/kernel/relayflowd-journal)
   Compiling relayflowd v0.1.0 (/Users/khaliqgant/AgentWorkforce/flows-225-placement-wt/kernel/relayflowd)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 2.99s
     Running tests/spec_review_routing.rs (kernel/target/debug/deps/spec_review_routing-a37130322a188264)

running 4 tests
test attempt_scoped_route_is_rejected_at_append_and_replay ... ok
test malformed_epoch_routes_are_rejected_before_commit ... ok
test epoch_cannot_drop_or_replace_a_durable_route ... ok
test workspace_pin_peels_tags_and_refuses_non_commit_objects ... ok

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s


exit_code=0
```

The complete kernel workspace command/output is in `kernel/evidence/225/spec-review-kernel-tests-final.txt`, including 40 crash/resume tests. The first workspace attempt failed during doctests because ambient rustdoc differed from selected rustc; that failed output remains in `spec-review-kernel-tests.txt`. Matching RUSTC/RUSTDOC fixed the environment mismatch without code/gate changes. SDK captured output:
```
$ node node_modules/vitest/vitest.mjs run tests/placement.test.ts tests/spec-parity.test.ts tests/verb-field-lint.test.ts

 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-225-placement-wt/packages/sdk

 ✓ tests/placement.test.ts (54 tests) 11ms
 ✓ tests/spec-parity.test.ts (31 tests) 226ms
 ✓ tests/verb-field-lint.test.ts (78 tests) 518ms
   ✓ closed per-verb step fields > carries the llm/agent `output` sugar through every path > flows check accepts output on llm 321ms

 Test Files  3 passed (3)
      Tests  163 passed (163)
   Start at  23:52:12
   Duration  1.23s (transform 359ms, setup 0ms, collect 1.16s, tests 755ms, environment 0ms, prepare 170ms)


exit_code=0
```

The earlier descriptor snapshot and blank routing-field findings were already addressed at the reviewed head; other outstanding threads need acknowledgement of the actual fixes. CI was previously credential-blocked; the newly pushed head must earn its own checks. Passing tests cannot override the two P1 findings above. No merge.
