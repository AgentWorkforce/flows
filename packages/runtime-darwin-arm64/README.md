# @relayflows/runtime-darwin-arm64

Prebuilt Relayflow v2 runtime for `darwin-arm64` (Apple Silicon):

- `bin/relayflowd` — the kernel daemon (Rust, `cargo build --release -p relayflowd`, target `aarch64-apple-darwin`)
- `bin/flows` — the standalone CLI (`bun build --target=bun-darwin-arm64`)

Built natively on a `macos-14` GitHub Actions runner from the same commit and
tag as every other release package, and published with npm provenance.

This package is platform-specific by design. It declares `os`/`cpu`, so npm
refuses to install it anywhere else rather than yielding a binary that cannot
run. `@relayflows/sdk`'s `relayflowd-path.ts` resolves it as an optional
dependency of the `relayflows` CLI package — installing `relayflows` on an
Apple Silicon Mac pulls this in automatically; every other platform's npm
skips it.

Intel Macs (`darwin-x64`) are not covered by this package and fall through to
`relayflowd-path.ts`'s later resolution steps (a source checkout or `PATH`)
until a `@relayflows/runtime-darwin-x64` package exists.
