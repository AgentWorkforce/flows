# @relayflows/runtime-linux-x64

Prebuilt Relayflow v2 runtime for `linux-x64`:

- `bin/relayflowd` — the kernel daemon (Rust, `cargo build --release -p relayflowd`)
- `bin/flows` — the standalone CLI (`bun build --target=bun-linux-x64`)

Both are the exact binaries the repository's cloud runtime artifact ships, built
from the same commit and published with npm provenance.

This package is platform-specific by design. It declares `os`/`cpu`, so npm
refuses to install it anywhere else rather than yielding a binary that cannot
run. A cross-platform wrapper that selects among per-platform packages is the
natural next step once a second platform is built; today CI produces linux-x64
only, and publishing a wrapper that can resolve exactly one platform would
promise a portability that does not exist.
