#!/bin/sh
# Hermetic cargo: pins CARGO_HOME into the repo so a run never depends on, or
# pollutes, a machine-global cargo store.
#
# It also has to FIND cargo. A cloud sandbox puts rustup's shims on PATH for
# interactive/agent shells but not for the deterministic step shell, where
# `cargo` resolved to nothing and the step died with
# `env: 'cargo': No such file or directory` (run f18ec684, verify-1) — even
# though the agent step in the same sandbox had just compiled and tested the
# whole workspace. So: use cargo from PATH when it is there, otherwise fall
# back to the standard rustup locations before giving up with a clear message.
set -eu

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)

if command -v cargo >/dev/null 2>&1; then
  cargo_bin=cargo
elif [ -x "${CARGO_INSTALL_ROOT:-}/bin/cargo" ]; then
  cargo_bin="${CARGO_INSTALL_ROOT}/bin/cargo"
elif [ -x "$HOME/.cargo/bin/cargo" ]; then
  cargo_bin="$HOME/.cargo/bin/cargo"
elif [ -x /usr/local/cargo/bin/cargo ]; then
  cargo_bin=/usr/local/cargo/bin/cargo
elif [ -x "$repo_root/.cargo-home/bin/cargo" ]; then
  cargo_bin="$repo_root/.cargo-home/bin/cargo"
else
  # No toolchain anywhere. In a cloud sandbox this is expected, and it is NOT
  # simply "off PATH": the image ships no Rust, and a step that installs one
  # cannot hand it to the next step because artifact propagation drops files
  # over a per-file size cap — observed on run f18ec684:
  #   artifact-skip: path ".cargo-home/bin/rustup" reason "size-cap"
  #   (20838840 bytes exceeds per-file cap)
  # So every step that needs cargo must be able to obtain it itself. Install
  # into the repo-local CARGO_HOME, which is where this wrapper already points.
  if [ "${RELAYFLOWS_NO_TOOLCHAIN_INSTALL:-0}" = "1" ]; then
    echo "CARGO_NOT_FOUND: no toolchain, and install is disabled by RELAYFLOWS_NO_TOOLCHAIN_INSTALL=1." >&2
    echo "  PATH=$PATH" >&2
    exit 127
  fi

  echo "CARGO_BOOTSTRAP: no toolchain found — installing rustup into $repo_root/.cargo-home" >&2
  if ! command -v curl >/dev/null 2>&1; then
    echo "CARGO_BOOTSTRAP_FAILED: curl is not available, so the toolchain cannot be fetched." >&2
    exit 127
  fi
  if ! CARGO_HOME="$repo_root/.cargo-home" RUSTUP_HOME="$repo_root/.rustup" \
       curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
       | CARGO_HOME="$repo_root/.cargo-home" RUSTUP_HOME="$repo_root/.rustup" \
         sh -s -- -y --default-toolchain stable --profile minimal --no-modify-path >&2; then
    echo "CARGO_BOOTSTRAP_FAILED: rustup install did not succeed." >&2
    exit 127
  fi
  if [ ! -x "$repo_root/.cargo-home/bin/cargo" ]; then
    echo "CARGO_BOOTSTRAP_FAILED: rustup reported success but no cargo at $repo_root/.cargo-home/bin/cargo" >&2
    exit 127
  fi
  echo "CARGO_BOOTSTRAP_OK: $($repo_root/.cargo-home/bin/cargo --version 2>&1)" >&2
  cargo_bin="$repo_root/.cargo-home/bin/cargo"
fi

export RUSTUP_HOME="${RUSTUP_HOME:-$repo_root/.rustup}"

exec env CARGO_HOME="$repo_root/.cargo-home" "$cargo_bin" "$@"
