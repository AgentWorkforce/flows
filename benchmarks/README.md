# Relayflows evidence and benchmarks

This directory separates two claims that must not be blended:

1. `durability/suite.json` is a product conformance eval. It repeatedly executes
   one independent Node black-box SIGKILL/CLI-resume case plus real Rust
   crash/resume tests, and captures their literal output and provenance. It
   shows which Relayflows invariants held for the tested commit and host.
2. `workflow-reliability/protocol.json` is a vendor-neutral competitive protocol.
   It defines the same workloads and success predicates for Relayflows, a
   build-it-yourself reference, Temporal, and Inngest. No comparative claim is
   valid until the required participants have run the same pinned protocol.

In this repository, **deterministic** means deterministic orchestration and
exactly-once declared effects under the tested faults. It does not mean an LLM
will emit identical text twice. Quality is measured separately by deterministic
gates and task-specific evals, matching RFC-0001 settled decision 11.

The black-box case models loss of an execution environment by killing both the
daemon and its in-flight child process before resume. Killing only the daemon
while deliberately leaving its child alive is not environment loss: the old
attempt can continue beside its replacement, so that is a different workload
with different ownership requirements.

## Run the durability eval

From the repository root:

```bash
node scripts/run-evals.mjs \
  --suite benchmarks/durability/suite.json \
  --output /tmp/relayflows-durability-v1.json
```

The runner refuses a dirty tree by default and requires report output to live
outside the source tree, so one result cannot silently dirty the next run.
`--allow-dirty` exists for local development, but permanently marks the artifact
`publicationStatus: ineligible` and exits nonzero. A publishable result also
requires the suite's minimum repetition count, zero failed trials, and explicit
output witnesses proving each selected test actually ran. Every trial records
its argv, working directory, duration, outcome, exit code, stdout, and stderr;
the report records the suite hash, source commit, toolchain, and host class.

Trial processes receive and record a small allowlist of ambient variables
(`HOME`, locale, `PATH`, temporary-directory variables, shell, and Relayflows
toolchain controls), plus any explicit per-case environment. Credentials and
unrelated ambient state are neither inherited nor written to the report. A
command timeout is a product failure blocker (`trial_timeouts`), not an
environmental excuse.

The black-box crash case stays on the supported CLI boundary. It obtains an
opaque run receipt from `run --stop-after 1`, resumes that run, kills the
workflow while the next step is in flight, then resumes again using the receipt.
It does not inspect journal files or storage layout. Its fixed, named assertion
set is emitted in the report, so the witness cannot pass by merely agreeing
with its own dynamic count.

## Claim discipline

- A passing durability artifact supports only its seven named claims. It is not a
  general proof that every execution path is deterministic.
- A build-vs-buy claim requires both `relayflows` and `diy-reference` results.
- A “best in class” claim requires all participants named by the protocol.
- Latency, cost, and implementation-burden metrics stay separate. A composite
  score requires preregistered weights for a named customer profile.
- Environment failures are inconclusive and must remain in the raw results.

The next benchmark rung is implementing the platform-neutral scenario adapters,
starting with Relayflows and the DIY reference. The internal durability suite is
not reused as a competitor workload because doing so would privilege Relayflows'
implementation rather than test the shared behavioral contract.
