# Relayflow kernel

Run the kernel gate from this directory through the repository wrapper:

```sh
../ops/cargo.sh test --workspace
../ops/cargo.sh clippy --workspace -- -D warnings
../ops/cargo.sh fmt --check
```

The wrapper sets `CARGO_HOME` to the repository-local `.cargo-home/` directory.
This keeps dependency downloads isolated from machine state, including a broken
`~/.cargo/registry` symlink, without committing vendored crate sources. Cargo
still resolves the exact dependency versions pinned in `Cargo.lock`.
