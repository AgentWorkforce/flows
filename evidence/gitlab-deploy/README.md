# `flows deploy --repo` targeting a GitLab project (cloud#3801)

`flows deploy <file> --repo <group/project> --on gitlab:…` was refused with
`flow_repository_unapproved`: the CLI sent `repository` with no `host`, so Cloud
read every target as GitHub. `--repo` now names a host explicitly and sends
`{ owner, name, host: 'gitlab' }` for a GitLab project; bare `owner/name` still
means GitHub.

## What is captured here

| File | Command | Result |
| --- | --- | --- |
| `typecheck.txt` | `npm run typecheck` + `npm run typecheck:tests` | clean, `exit=0` |
| `targeted.txt` | `vitest run tests/cloud-deploy.test.ts tests/relay-cli-surface.test.ts tests/flow-requirements.test.ts` | `201 passed (201)` |
| `mutation-host-propagation.txt` | revert the `host` spread, run, restore, re-run | `12 failed` → restore → `100 passed` |
| `full-suite.txt` | the `SDK suite` section of `.relayflow/check.sh` | `31 failed \| 3747 passed \| 4 skipped` |
| `environment.txt` | the probes behind every one of those 31 failures | both causes reproduce |

`mutation-host-propagation.txt` is mutation verification in the strict sense:
it reverts exactly the `host: 'gitlab'` spread in `parseRepository`, captures
the 12 failures, restores the line, and re-runs to capture the 100 passes. The
file records `sha256sum` of the source before the mutation and after the
restore; the two digests match, so the restore was byte-for-byte.

## The 31 full-suite failures are environmental, not this change

None of them is in a file this change touches, and both causes are machine
properties reproduced in `environment.txt`:

- **24 failures** (`hosted-extension-isolation`, `hosted-extension-protocol`,
  `software-garden-babysitter-composition`, `babysitter-native-extension`) need
  a usable bubblewrap. `/usr/bin/bwrap` is installed but
  `kernel.apparmor_restrict_unprivileged_userns=1`, and the `sysctl -w` that CI
  performs is refused here even under passwordless root because `/proc/sys` is a
  sysbox FUSE mount. Those tests gate on `existsSync('/usr/bin/bwrap')`, so a
  present-but-unusable bwrap fails where it would otherwise skip. Widening that
  guard would weaken the isolation tests that are the point of those files, so
  it was not done.
- **7 failures** in `live-kernel.test.ts` need a checkout with no CommonJS
  ancestor `package.json`. The `testdata/preflight/` fixtures are deliberately
  extensionless ES modules; this checkout sits under `/home/daytona`, whose
  `package.json` declares `"type": "commonjs"`, which disables module-syntax
  detection and makes the fixture exit 0 having run nothing. CI checks out at
  `/home/runner/work/<repo>/<repo>` with no such ancestor.

Both are recorded in `.relayflow/repair-notes.md` with the shadow-`package.json`
experiment that isolates the second cause.

## Scope this evidence does not cover

No run was made against live Cloud: that needs a workspace credential with a
GitLab connection, which this machine does not have. The request body is pinned
by assertion on the captured `POST /api/v1/flows/deploy` body in
`tests/cloud-deploy.test.ts`, not by a live deploy.
