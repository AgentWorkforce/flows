# PR #248 review corrections

The unsupported claim in commit b8c771c that four deliberate mutations each
failed and restored scripts then passed is withdrawn. The available record
does not contain the commands, failures, byte-for-byte restoration, and restored
passes needed to substantiate it. This correction does not rewrite that commit
or claim those historical experiments did or did not happen. No mutation
verification is claimed by this follow-up.

The ordinary baseline suite passed on this host. The first comparator did not
intercept production's negated `[ ! file -nt marker ]` expression. Its original
coarse-before/coarse-after captures are NOT evidence of simulated coarse
timestamps; that claim is withdrawn. A probe counting `stat` calls reproduces
the missing interception (2 calls before, 4 after supporting both forms).
The corrected comparator is used in corrected-before/corrected-after captures.
The baseline probe executes the original 066e2de scripts in a temporary fixture;
it does not edit the current checkout's gate scripts.
Fixed timestamps replace the unit test's wall-clock dependency, and an explicit
equal-mtime case remains STALE. The end-to-end objection assertion also requires
the reported verdict to be FAILED, so a stale transcript cannot stand in for a
real objection.

The complete commands/output and the comparator source are recorded in the
adjacent swarm-threads-0909-*.txt files. The comparator is a macOS reproduction
fixture that wraps Bash's `[` for plain and negated `-nt`, using integer
`stat -f %m` values; it does not alter the production parser or judging gate.
Native and corrected coarse-timestamp runs exercise the real swarm-post.sh with
offline CLI stubs. They do not prove a live agent follows a prompt.

The YAML now names the exact parser file and function. Empty-sync missing-comment
behavior is diagnostic output outside pass/fail accounting, so repairing it
later will not fail a test that required the bug. The existing liveness-only
annotations are preserved.

The CI review and its self-test come from the immutable main checkout. These
changes remain candidates for human review; they do not replace the gate that
judges this PR, and a local test pass is not a swarm signoff.
