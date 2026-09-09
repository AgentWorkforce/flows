# Local drive packages

Build the SDK before launching `workflows/drive-local.yaml`:

```sh
npm --prefix packages/sdk run build
node scripts/run-local-workflow.mjs workflows/drive-local.yaml
```

Run on the branch that should receive the diff, from a clean checkout. The
flow leaves delivery to the operator. It does not commit or merge.

Selection uses the SDK backlog picker. A locally executable entry must name
repository paths committed at HEAD in backticks and declare at least one acceptance
command on an indented `Verify:` line. Each command is a JSON argv array,
executed at the repository root with a two-minute bound. For example:

```text
- **Fix the value** Update `src/value.txt` to contain exactly "fixed".
  Verify: ["node", "-e", "require('node:assert/strict').equal(require('node:fs').readFileSync('src/value.txt','utf8'),'fixed')"]
```

Multiple `Verify:` lines mean all commands must pass. Commands come from the
backlog before implementation; the agent cannot substitute its own acceptance
checks in package.json. Entries with no executable checks are skipped with
`missing_executable_checks`, alongside the existing unbounded/stale scope
reasons. The old F8b entry now carries a source assertion for its declared
rename. That assertion also allows an already-completed package to pass
without manufacturing another edit.

The submitted scope step first refuses changes to its helper scripts and
backlog before executing either helper. It then checks the working tree and
index against the selected HEAD, including untracked non-ignored files and
both sides of renames. Scope uses exact paths or directory descendants, never
string-prefix siblings. Backlog, verifier and gate changes fail even when a
package names a containing directory. Symlink changes are refused. Ignored
build/runtime artifacts are excluded from this Git diff boundary; it is not an
OS filesystem sandbox or protection against a process rewriting Git metadata.
Pre-existing unresolved symlinks under directory scopes are refused: creating
a file through a dangling symlink can write outside the checkout.

Verification reconstructs the selected work from the unchanged backlog and
compares its scope and commands to package.json. Each package check must pass
before the SDK regression suite runs. An unchanged implementation whose DoD
is unmet fails. HEAD/branch changes fail, and out-of-scope changes produced by
an acceptance command fail too. A failed scope or verification step prevents
the dependent report step from running.

The scope command runs again after the SDK build and suite, before reporting.
Reports include tracked changes against HEAD and non-ignored untracked paths.

Known trust-boundary blockers remain: ignored package metadata can be repinned
after a commit, and `.drive-gate` scripts and their checksum manifest can be
rewritten together. Neither is an independently owned baseline. Acceptance
commands can also load mutable scripts from implementation scope. See
`runtime-evidence/drive-threads-0909-decisions.md`; this flow is not ready for
unattended use until ownership of that baseline and the acceptance inputs is
settled and enforced.
