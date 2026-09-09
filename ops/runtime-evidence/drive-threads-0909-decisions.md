# PR #244: remaining trust-boundary decisions

The reporting, post-suite scope, dangling-link, fixture dependency, and evidence
narrative fixes do not close the following blockers. No swarm pass is claimed.

1. **Who owns the selected baseline and gate manifest?** Both the selected HEAD
   in ignored package.json and the snapshot's SHA256SUMS live in the agent's
   writable checkout. Pinning one writable file with another is insufficient.
   The local launcher currently submits a static spec and runs the agent in the
   same filesystem. A trusted pre-submission launcher baseline embedded in the
   submitted commands, or a separately owned gate execution surface, is needed.
   This crosses the current flow/helper scope into launcher ownership. Recommend
   the launcher capture the original branch, HEAD, package and gate inputs
   before submission, then execute checks from that independently owned state.
   The human must choose that ownership boundary before this flow claims it.
2. **How are acceptance-check inputs declared?** Immutable argv alone does not
   freeze a script or its imports. A command such as `node src/check.mjs` can
   execute an agent-edited judge. Inferring its transitive inputs from arbitrary
   argv is not reliable. Choose a declared immutable gate-input contract or an
   independently preserved acceptance workspace that tests the changed source.
   Do not silently narrow the existing arbitrary-argv authoring contract.

Reproduce the first two bypasses from the repository root:

```sh
node ops/runtime-evidence/drive-threads-0909-trust-probe.mjs
```

The complete probe and captured output are adjacent files. Both scope commands
exit zero, including after committing an out-of-scope change and repinning the
metadata, and after rewriting the snapshot plus its checksum manifest. This is
failure evidence, not a passing security test.

The old package tests also lacked the snapshot required by the current flow.
`drive-threads-0909-baseline.txt` captures those failures. The fixture now runs
the submitted snapshot step with the real TypeScript compiler over the actual
picker source before exercising the submitted scope command.

`drive-threads-0909-review-before.txt` and
`drive-threads-0909-post-suite-before.txt` capture regression failures before
their corresponding fixes. `drive-threads-0909-after.txt` captures the package
and review test run after those fixes. These are before/after reproductions;
no mutation-verification claim is made.
