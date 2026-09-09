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

## Evidence lifecycle for this batch

These files are historical command captures and narrowly scoped reproduction
probes, not shared runtime helpers or automatically discovered test fixtures.
Keep superseded captures for the audit trail; their headers withdraw the claims
they cannot support. Do not regenerate an old capture in place. A later repair
gets a new descriptive suffix and its literal command/output, while its note
identifies what it supersedes. This convention applies to this review batch,
not a new policy for unrelated evidence directories.

All names below start with `swarm-threads-0909-` (review task and capture date):

| Suffix | Meaning |
| --- | --- |
| `before.txt`, `after.txt` | Native self-test before/after the first repair |
| `coarse-before.txt`, `coarse-after.txt` | Superseded first comparator captures; retained only for audit |
| `comparator-before.txt`, `comparator-after.txt` | Probe exposing the missing negated interception, then its repair |
| `corrected-before-initial.txt` | Original self-test happened to pass with the corrected comparator |
| `corrected-before.txt` | Bounded retry captured the timing failure; passing attempts are never hidden |
| `corrected-after.txt` | Fixed self-test under the corrected comparator |
| `round3-*.txt` | Follow-up captures for documentation, bootstrap refusal, and fixture repairs |

Run the native shell suite for current regression checks. Use the macOS-only
comparator/probes only to investigate the specific historical timestamp issue.
The baseline probe requires the original `066e2de` Git objects and intentionally
reads those old scripts into a temporary fixture. Its output is timing-dependent.
