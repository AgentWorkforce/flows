# relayflows

The `flows` CLI, published under the unscoped name so the install is just:

```sh
npm install -g relayflows
```

This package carries no logic of its own. It declares `@relayflows/sdk` as a
normal dependency and `bin/flows.js` forwards argv and stdio straight to that
dependency's `dist/cli.js`, resolved by filesystem path from this package's
own `node_modules` rather than by import specifier — the SDK's package
`exports` doesn't list that subpath, so a bare `import` would be refused.

Versioned and released in lockstep with `@relayflows/sdk`: the two always
carry the same version number, and this package pins its dependency to that
exact version rather than a range, so `npm install -g relayflows` always
resolves the SDK build it shipped with.

It also declares the per-platform runtime packages
(`@relayflows/runtime-linux-x64`, `@relayflows/runtime-darwin-arm64`) as
`optionalDependencies`, pinned the same way. Each declares `os`/`cpu`, so npm
installs only the one matching the current machine and silently skips the
rest — this is what lets `flows run` spawn `relayflowd` with no manual build
step (`kernel/DAEMON-LIFECYCLE.md` §3.1's `relayflowd-path.ts` resolution
finds it as an optional dependency of this package). A platform with no
runtime package yet (Intel Mac, Windows) installs `relayflows` fine; `flows`
then falls through to a source checkout or `PATH`, and refuses with
`relayflowd_not_found` if neither has a binary.

See `@relayflows/sdk` and `docs/SURFACE.md` for what the CLI actually does.
