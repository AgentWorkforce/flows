#!/bin/sh
# Cargo with a private toolchain home, so a run neither depends on nor pollutes
# a machine-global cargo store — while keeping that home OUT of the repo.
#
# It also has to FIND cargo. A cloud sandbox puts rustup's shims on PATH for
# interactive/agent shells but not for the deterministic step shell, where
# `cargo` resolved to nothing and the step died with
# `env: 'cargo': No such file or directory` (run f18ec684, verify-1) — even
# though the agent step in the same sandbox had just compiled and tested the
# whole workspace. So: use cargo from PATH when it is there, fall back to the
# standard rustup locations, then install one, and only then give up.
set -eu

# The toolchain must live OUTSIDE the repo. It used to sit in
# the repo's own .cargo-home for hermeticity, and in a cloud sandbox that was
# exactly wrong: the executor propagates the workspace between steps and drops
# files over a per-file size cap, so a toolchain installed in one step arrived
# in the next with pieces missing —
#   error: Missing manifest in toolchain 'stable-x86_64-unknown-linux-gnu'
# (run 4b40159d, verify-1). A partial copy is worse than no copy: it looks
# installed and fails on use. Keeping it out of the propagated tree means each
# step either finds a whole toolchain or installs one.
toolchain_home="${RELAYFLOWS_TOOLCHAIN_HOME:-$HOME/.relayflows-toolchain}"
export CARGO_HOME="$toolchain_home/cargo"
export RUSTUP_HOME="$toolchain_home/rustup"

if command -v cargo >/dev/null 2>&1; then
  cargo_bin=cargo
elif [ -x "${CARGO_INSTALL_ROOT:-}/bin/cargo" ]; then
  cargo_bin="${CARGO_INSTALL_ROOT}/bin/cargo"
elif [ -x "$HOME/.cargo/bin/cargo" ]; then
  cargo_bin="$HOME/.cargo/bin/cargo"
elif [ -x /usr/local/cargo/bin/cargo ]; then
  cargo_bin=/usr/local/cargo/bin/cargo
elif [ -x "$CARGO_HOME/bin/cargo" ]; then
  cargo_bin="$CARGO_HOME/bin/cargo"
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

  echo "CARGO_BOOTSTRAP: no toolchain found — installing rustup into $toolchain_home" >&2
  if ! command -v curl >/dev/null 2>&1; then
    echo "CARGO_BOOTSTRAP_FAILED: curl is not available, so the toolchain cannot be fetched." >&2
    exit 127
  fi
  # Remove any partial toolchain first: a half-copied one reports
  # "Missing manifest" rather than "not installed", and rustup will happily
  # leave it in place.
  rm -rf "$toolchain_home"
  mkdir -p "$toolchain_home"
  # Bound the install ourselves. On run 457a6102 verify-1 sat for 31 minutes
  # against a declared 20-minute step timeout with no output, so the platform's
  # bound is not something to rely on: a step CAN outlive its timeoutMs. An
  # unbounded `curl | sh` inside an unenforced timeout can hang for the whole
  # 8-hour run budget.
  timeout_bin=""
  if command -v timeout >/dev/null 2>&1; then timeout_bin="timeout"
  elif command -v gtimeout >/dev/null 2>&1; then timeout_bin="gtimeout"
  fi
  install_cmd="sh -s -- -y --default-toolchain stable --profile minimal --no-modify-path"
  if [ -n "$timeout_bin" ]; then
    install_cmd="$timeout_bin ${RELAYFLOWS_TOOLCHAIN_INSTALL_TIMEOUT:-600} $install_cmd"
  else
    echo "CARGO_BOOTSTRAP_WARN: no timeout(1) available; the install is unbounded here." >&2
  fi
  if ! curl --proto '=https' --tlsv1.2 -sSf --max-time 300 https://sh.rustup.rs \
       | $install_cmd >&2; then
    echo "CARGO_BOOTSTRAP_FAILED: rustup install did not succeed (or exceeded its ${RELAYFLOWS_TOOLCHAIN_INSTALL_TIMEOUT:-600}s bound)." >&2
    exit 127
  fi
  if [ ! -x "$CARGO_HOME/bin/cargo" ]; then
    echo "CARGO_BOOTSTRAP_FAILED: rustup reported success but no cargo at $CARGO_HOME/bin/cargo" >&2
    exit 127
  fi
  # Prove the toolchain is whole, not merely present: `cargo --version` is what
  # caught the partial copy above.
  if ! "$CARGO_HOME/bin/cargo" --version >/dev/null 2>&1; then
    echo "CARGO_BOOTSTRAP_FAILED: cargo exists at $CARGO_HOME/bin/cargo but cannot run — partial toolchain." >&2
    "$CARGO_HOME/bin/cargo" --version >&2 2>&1 || true
    exit 127
  fi
  echo "CARGO_BOOTSTRAP_OK: $("$CARGO_HOME/bin/cargo" --version 2>&1)" >&2
  cargo_bin="$CARGO_HOME/bin/cargo"
fi


exec "$cargo_bin" "$@"
