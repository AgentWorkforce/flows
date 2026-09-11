# Adep minimal slice for #333

This branch implements file-bucket deploy and digest-run for self-contained
YAML/declarative deterministic flows. It does not close all of #333.

The new tests cover signed payload layout, idempotency, missing/unwritable
buckets, corruption before transport or journal creation, cache reuse and
corruption, bucket configuration/override, exact canonical spec submission,
and explicit refusal of asset execution. A real-kernel test deletes the local
source and build output before running the deployed digest to success.

`verification.txt` contains literal commands, output, and exit codes. The live
check uses an already-built local relayflowd via the recorded RELAYFLOWD_BIN;
this branch does not modify the kernel. The initial regression run exposed
local dependency drift, then Bun missing from PATH. The failed outputs and
the reruns after restoring dependencies and adding the installed Bun to PATH
are retained.

Follow-up: S3 transport; trigger digest pinning/conflict validation; authored TS,
assets and placement; agent/LLM environment checks; separate environment-only
preflight (this slice retains the existing checks). Deploy-time execution support
is deliberately refused for those bundle kinds. Linux artifact and packed-consumer
CI are left to the lead's PR workflow; they were not run on this node.
