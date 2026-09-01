# Build sandbox Git metadata is unavailable

The Track D implementation and its parse/syntax/SDK test commands pass, but the
definition of done cannot complete because this workspace's `.git` file points
to `/home/daytona/.project-git`, which does not exist. The repository is private
and this sandbox has no GitHub credentials, so the missing object store cannot
be reconstructed safely from `origin`.

Human/platform action: provide the worktree's Git directory at the path named by
`.git` (or seed the sandbox with a valid repository), then rerun
`git status --porcelain` from the repository root.
