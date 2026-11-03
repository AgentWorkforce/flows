# Stage F push fence: real-Git evidence

`fence-race.py` builds a bare remote and a clone in a temp directory, and adds a
`pre-receive` hook that moves `refs/heads/land/run` to a newer commit *after*
the advertisement and *before* the update: a newer submission arriving while
a superseded stage F pushes.

- `noop`: the previous fence (`<pinned>:refs/heads/land/run` with
  `--force-with-lease`). Git drops the up-to-date ref from the transaction, so
  the old squash lands on `main` (exit 0). This is the review finding on #695.
- `delete`: the current fence (`:refs/heads/land/run` with the lease). The
  delete is a real update carrying the pinned old value, checked inside the
  atomic transaction: the push fails and `main` is untouched.
- `delete`, no race: the squash lands and the land ref is deleted.

Run: `python3 -I examples/land/evidence/push-fence/fence-race.py` (local git only).

## Permission the fence needs

Stage F deletes the land ref as part of the push, so the auto write grant must
allow deleting `land/*` branches (no branch rule may block their deletion). A
`--dry-run` push cannot prove branch rules, so the preflight does not check
this; a rule that blocks it ends F `needs_human` with GitHub's rejection.
