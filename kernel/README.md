# Relayflow kernel

Run the kernel gate from this directory with plain Cargo commands:

```sh
cargo test --workspace
cargo clippy --workspace -- -D warnings
cargo fmt --check
```

`.cargo/config.toml` redirects the locked crates.io dependencies to the
repo-local `vendor/` source. This keeps clean-checkout builds deterministic and
avoids reliance on the machine's `CARGO_HOME`; update the source alongside
`Cargo.lock` with
`CARGO_HOME="$(pwd)/.cargo-home" cargo vendor --locked vendor`.
