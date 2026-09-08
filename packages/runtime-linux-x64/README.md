# @relayflows/runtime-linux-x64

Prebuilt `relayflowd` kernel daemon for `linux-x64`. Install `relayflows` to get
the `flows` command backed by `@relayflows/sdk`; this package exports only
`relayflowd`, so it cannot replace the SDK CLI during npm's bin linking.

The daemon is built from the release commit and published with npm provenance.
The package declares `os`/`cpu` and is an optional dependency of `relayflows`.
Unsupported platforms need a locally built daemon via `RELAYFLOWD_BIN`.

The tarball also retains the legacy `bin/flows` executable required by the
existing release gate. It is not registered as an npm command. Removing it
from the archive requires a separate change by the release-gate owner.
