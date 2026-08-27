#!/bin/sh
set -eu

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)

exec env CARGO_HOME="$repo_root/.cargo-home" cargo "$@"
