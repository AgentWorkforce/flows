# Slice X verification

Implemented mapping-driven Slack/GitHub declarations, provider envelope ingress,
and lowering to the existing webhook inbox executor. The generator also accepts
an adapter checkout. No kernel production code changed.

Commands and captured outputs:

- [Surface typecheck](surface-typecheck.txt): exit 0.
- [Surface regression typecheck and generated helper check](surface-regressions.txt): exit 0.
- [SDK source and type contracts](sdk-typecheck.txt): exit 0.
- [SDK test typecheck](sdk-test-types.txt): exit 0.
- [Surface suite](surface-tests.txt): 28 passed.
- [Provider executor and codegen tests](provider-tests.txt): 7 passed. These
  exercise the compiled subscriptions through the real kernel CLI, including
  provider/type/payload nonmatches, distinct event IDs, and durable deduplication.
- [Existing inbox watcher tests](inbox-watcher.txt): 3 passed.
- [Full SDK suite attempt](sdk.txt): 185 failed, 1109 passed, 10 skipped,
  14 errors. This is **not a green full-suite result**. The provider HTTP tests
  fail at socket creation with `listen EPERM: operation not permitted 127.0.0.1`.
  The full transcript also contains Unix socket permission failures, a filesystem
  watch `EMFILE`, and a wrapper identification timeout. The SDK transcript excerpt
  links the complete local log. The additional provider kernel CLI tests were
  completed separately after this full-suite attempt.

Local dependencies were installed from the npm cache for the SDK. The surface's
pre-existing npm lockfile omits its relay-helpers peer dependency; its installed
dependencies were copied from the local helpers worktree, with `ai-hist` copied
from the SDK installation. The SDK used this worktree's built surface through a
local node_modules link. These setup changes do not modify tracked lockfiles.

One surface regression attempt hit a transient `ENOSPC` while creating a temp
directory; the captured rerun passed. Socket restrictions remain unresolved:
this session cannot request execution outside the sandbox. The HTTP/daemon tests
are retained and must be rerun in an environment that permits local sockets.
