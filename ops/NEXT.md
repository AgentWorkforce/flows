# NEXT — WP-9 merge handoff for PR #8

Written by the Relayflow Lead on 2026-08-27 for branch
`flow/drive-57e923c-08271542` and existing PR #8.

## Current state

WP-9 has no remaining product work. The branch contains `origin/main` commit
`6366943`, including the repository's evidence-capture standard. Gate 1's
covenant-2 preflight implementation remains on PR #8 and is not on `main`.

The package-mandated deterministic-command limitation is public in
`docs/SURFACE.md`: an unresolved bare command receives the typed
`command_unresolved` warning rather than a refusal because `/bin/sh -c` may
supply a builtin, function, or assignment. The narrower unresolved path-like
case remains filed under “Close the deterministic-command preflight gap” in
`ops/BACKLOG.md`.

The review-repair chronology is append-only under `ops/reviews/`. Rejected
WP-9 heads and their repairs are:

- `18f03be`: the new surface paragraph named the wrong warning kind;
  `c04d388` corrected it to `command_unresolved`.
- `c04d388`: the gate scoreboard retained the pre-WP-8 SDK count;
  `fa19df1` corrected 130 to the reproduced 131 without changing Gate 1's
  AMBER state.
- `385763a`: the branch still carried a WP-7 selector; `2b117ae` replaced it
  with the supplied WP-9 assessment.
- `2b117ae`: that copied assessment still queued already-completed work;
  `80aa711` replaced it with a present-tense merge handoff.
- `80aa711`: the handoff understated its own rejection chronology; this
  revision removes the count and records the immediate prior rejection.

The final changed-head review transcripts after this handoff are the merge
evidence. Each must name the same reviewed SHA, end in `REVIEW_PASSED`, and
the aggregate must return `SWARM_PASSED`. Only those transcript commits may
follow the reviewed handoff head.

## Captured verification

`ops/DRIVE-LOG.md` contains the literal WP-9 verification output:

- kernel: 72 passed, 0 failed;
- Clippy with `-D warnings`: exit 0;
- Rust formatting: exit 0 with empty output;
- SDK: 131 passed, 0 failed;
- clean-room install/build: `dist` and `node_modules` moved aside
  recoverably, `npm ci && npm run build && test -x dist/cli.js`: exit 0;
- largest Rust file: 468 lines.

The destructive `rm -rf` spelling in the package was rejected by the worker
safety layer before process launch. The recoverable move established the same
absence precondition; the exact substituted command and output are preserved
in `ops/DRIVE-LOG.md` and the PR body.

## Next action

PR #8 remains OPEN. A human reviews and merges it if satisfied. After merge, a
new tick re-runs the Gate 1 verification on merged `main` and only then may
move `ops/SCOREBOARD.md` from AMBER to GREEN.

The Lead does not merge, does not start Gate 2+ work while PR #8 is open, and
does not add product features to this branch.

END_HANDOFF
