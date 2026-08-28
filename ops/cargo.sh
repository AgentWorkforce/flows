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
else
  echo "CARGO_NOT_FOUND: no cargo on PATH, and none at \$HOME/.cargo/bin or /usr/local/cargo/bin." >&2
  echo "  PATH=$PATH" >&2
  echo "  A step that cannot find its toolchain must say so, not report a build failure." >&2
  exit 127
fi

exec env CARGO_HOME="$repo_root/.cargo-home" "$cargo_bin" "$@"
