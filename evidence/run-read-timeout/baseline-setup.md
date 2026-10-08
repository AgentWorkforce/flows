The handshake comparison used an unmodified detached checkout of
`3c58ee16d10a9e2400db980f5bbafac84e437f20`. The two probe sources are copied
verbatim from the `/tmp` scripts named in their captured output. They use this
session's absolute checkout/build paths; adjust those paths when reproducing
on another machine.

Setup used (from the implementation checkout):

```sh
git worktree add --detach /tmp/relayflow-read-timeout-baseline 3c58ee16d10a9e2400db980f5bbafac84e437f20
ln -s /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk/node_modules /tmp/relayflow-read-timeout-baseline/packages/sdk/node_modules
npm run build --prefix /tmp/relayflow-read-timeout-baseline/packages/sdk
```

The baseline probe loads SDK code from that checkout while keeping the daemon
binary and stub fixture path identical to the current-code probe. It compares
that one fixture handshake failure, not the full suite.
