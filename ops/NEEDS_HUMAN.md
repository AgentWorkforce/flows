# Gate 3 needs human workspace repair

The code and test gates pass locally, but the definition of done cannot be
completed because this checkout has no usable Git metadata. The repository's
`.git` file contains:

```
gitdir: /home/daytona/.project-git
```

That target does not exist. Consequently the required final command
`git status --porcelain` fails with `fatal: not a git repository:
/home/daytona/.project-git` instead of listing modified files. A human or the
workspace provisioner must restore the checkout's Git directory without
inventing repository state.

The source `sdk/src/worker.ts` required no edit in the delivered checkout. Its
targeted agent-worker test passed once the kernel binary was built. The second
targeted test and five full-suite tests were initially blocked because shell
fixtures arrived without executable modes; executable mode was restored on:

- `testdata/preflight/authenticated-cli`
- `testdata/preflight/counting-cli`
- `testdata/preflight/signal-probe-cli`
- `testdata/preflight/unauthenticated-cli`

