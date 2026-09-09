# PR #244: gate ownership and remaining acceptance-input decision

The launcher now captures the gate and baseline in the submitted spec. The
existing daemon journals the command bytes before any implementation worker
runs. HEAD, branch and backlog hash no longer come from agent-writable package
metadata; the judge no longer comes from `.drive-gate` plus a writable checksum.
The kernel and journal protocol are unchanged. The launcher starts from a
trusted checkout; this is not an OS sandbox against arbitrary process or
journal-storage tampering.

The contract and its owners are summarized in `../DRIVE-LOCAL.md`.
`local-work-verification.mjs` owns the protected-path policy once; YAML no longer
duplicates it. Test fixtures use the same preparing function as the launcher and
no longer symlink host node_modules or run a separate snapshot compiler.

**Remaining decision: how are acceptance-check inputs declared?** Immutable
argv alone does not freeze a script or its imports. A command such as
`node src/check.mjs` can execute an agent-edited judge. Inferring its transitive
inputs from arbitrary argv is not reliable. Choose a declared immutable
acceptance-input contract or an independently preserved acceptance workspace
that tests the changed source. Do not silently narrow the existing arbitrary
argv authoring contract. The flow remains blocked for unattended use; no swarm
pass is claimed.

`drive-threads-0909-acceptance-input-probe.mjs` reproduces this remaining bypass:
an unchanged broken value fails its original check, but replacing an allowed
check script with a no-op makes verification exit zero. The adjacent capture
records the literal command and output. A zero probe exit means the known
bypass was reproduced, not that this boundary is safe.

## Captured evidence lifecycle

- At commit `34349b2`, `drive-threads-0909-trust-probe.mjs` produced the adjacent
  `drive-threads-0909-trust-probe.txt`: repinning HEAD and rewriting a snapshot
  plus manifest were both accepted. That file is historical failure evidence.
  To reproduce those exact bytes, use that commit's probe and fixture together.
- The updated probe now asserts HEAD repinning is refused and a forged legacy
  snapshot cannot bless broken implementation. It then fixes the value and
  verifies the good case. `drive-threads-0909-owned-trust-after.txt` captures it.
- `drive-threads-0909-owned-gate-after.txt` captures the combined package, review,
  gate and real-daemon journal tests. The daemon cases assert failed completion
  reasons and that reporting never starts after a bypass attempt.
- Earlier `baseline`, `review-before`, `post-suite-before` and `after` captures
  retain their historical meaning. The old fixture compiled a snapshot, which
  is superseded by the preparing launcher. These are before/after reproductions;
  none is labeled mutation verification.
