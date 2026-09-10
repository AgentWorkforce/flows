# PR #244: pinned Git gate inputs and remaining acceptance-input decision

The user clarified the H1 design: copying working-tree bytes does not create a
trust boundary. The earlier command embedding at `4d88ac2` is superseded because
it also took its helper and compiled-picker inputs from the working tree.

The launcher now pins HEAD before submission. `gate-snapshot` extracts the
package helper, verifier and picker TypeScript source from that commit with
`git --no-replace-objects show`, and builds the picker in a temporary directory
outside the checkout before selection and implementation. The snapshot script
itself is loaded from the same ref. The package records it as `head`; checks
compare it to the submitted pin so repinning metadata cannot hide a moved HEAD.
No SHA256SUMS or adjacent ref file is used as authority.

The installed TypeScript compiler and local launcher remain trusted tools. A
same-user agent can still write to the extracted temp files. The claim is about
the origin of gate inputs, not same-user filesystem isolation or runtime-file
immutability. The kernel and journal protocol are unchanged.

The contract is summarized in `../DRIVE-LOCAL.md`. The fixture uses the same
preparer and actual snapshot step, commits source into its disposable Git repo,
and invokes the installed compiler without symlinking host node_modules.

`drive-threads-0909-git-input-before.txt` captures two failures before this fix:
a substituted working-tree helper or ignored compiled picker returned success
without selecting any package. The current regression tests also assert that
extracted bytes match Git, dirty TypeScript is ignored as input, committed
invalid TypeScript fails the snapshot build, and fixed implementation passes.
The combined captured run is `drive-threads-0909-git-input-after.txt`.

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
