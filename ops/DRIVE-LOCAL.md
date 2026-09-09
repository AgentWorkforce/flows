# Local drive packages

Launch from a trusted checkout with the SDK dependencies installed:

```sh
node scripts/run-drive-local.mjs
```

Run on the branch that should receive the diff, from a clean checkout. The
flow leaves delivery to the operator. It does not commit or merge. The wrapper
builds the SDK, captures the original HEAD, branch, backlog hash and gate code,
then submits the prepared commands through the existing local launcher. The
daemon journals those commands before implementation starts. Running the YAML
template directly refuses selection because these captured inputs are missing.

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

The submitted scope step executes the captured helper code and refuses changes
to its checkout sources and backlog. It checks the working tree and
index against the selected HEAD, including untracked non-ignored files and
both sides of renames. Scope uses exact paths or directory descendants, never
string-prefix siblings. Backlog, verifier and gate changes fail even when a
package names a containing directory. Symlink changes are refused. Ignored
build/runtime artifacts are excluded from this Git diff boundary; it is not an
OS filesystem sandbox. Moving HEAD or branch fails against the submitted pins,
even if the agent updates the ignored package metadata to match.
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

The execution contract has one owner for each kind of data:

| Input or policy | Owner and validation |
| --- | --- |
| Gate code, compiled picker, HEAD, branch, backlog hash | Preparing launcher captures bytes into submitted commands; daemon executes its journaled spec. No checkout snapshot or writable checksum is consulted. |
| Package metadata | Private atomic JSON artifact for the agent; scope, verify and report reconstruct its fields from the captured picker and pinned backlog. It cannot redefine the original HEAD. |
| Allowed paths and protected paths | Captured `local-work-verification.mjs`; index and working tree checked separately against the original HEAD, including non-ignored untracked files. |
| Acceptance argv | Parsed from the pinned backlog; every command must succeed, with scope rechecked after execution. |
| Acceptance scripts and dependencies | **Open blocker:** arbitrary argv can load mutable source from implementation scope. |

The remaining acceptance-input decision is documented in
`runtime-evidence/drive-threads-0909-decisions.md`. This flow is not ready for
unattended use until those inputs have an explicit enforced ownership contract.
