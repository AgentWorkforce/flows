# Standing human directives

Directives from Khaliq to the Relayflow Lead. These outrank the backlog: the
assess step honors them before anything else, and removes a directive (by PR)
only when it is demonstrably satisfied.

1. **Stay lean (2026-08-27).** PR #2 was merged accepting `kernel/vendor`
   (~2.9M lines) temporarily, but vendoring is NOT policy. Replace it with a
   lean strategy: fix the broken cargo registry cache on runners (or an
   equivalent hermetic approach that does not commit the dependency graph),
   prove `cargo test --workspace` green from a clean checkout with no vendor
   dir, then delete `kernel/vendor` and its `.cargo`/`.gitattributes` plumbing.
