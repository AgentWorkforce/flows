# Gate 3 blocked: checkout Git metadata is missing

The SDK and kernel definition-of-done test commands pass locally, but the
required final command cannot run because this checkout's `.git` file contains:

```text
gitdir: /home/daytona/.project-git
```

`/home/daytona/.project-git` does not exist, and no relocated project Git
metadata is present under `/home`, `/project`, or `/tmp`. Consequently the
literal command `git status --porcelain` fails with:

```text
fatal: not a git repository: /home/daytona/.project-git
```

The run needs the original Git directory restored at that path (or `.git`
updated to point at its actual location). Initializing a replacement repository
would fabricate status evidence and is therefore not an acceptable workaround.

No SDK or kernel source changes were needed: after installing the lockfile-pinned
SDK dependencies, restoring executable mode on the preflight CLI fixtures, and
building `relayflowd`, all 197 SDK tests and all kernel tests pass.
