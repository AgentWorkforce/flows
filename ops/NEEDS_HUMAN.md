# Git metadata required

The worktree's `.git` file points to `/home/daytona/.project-git`, but that
directory does not exist. Please either restore that Git directory mount or
provide the correct `gitdir` path. Without the repository metadata, the
definition-of-done command `git status --porcelain` cannot run, and creating a
new repository here would fabricate the baseline rather than verify the real
worktree.
