# Daemon lifecycle: the connection handshake and attach-or-spawn

Status: implementation spec. Scope: the handshake that lets
`npm install -g relayflows && flows run x.yaml` work without a human first
running `relayflowd serve`. Nothing else.

Today `flows run` / `flows resume` open `<data-dir>/relayflowd.sock` and fail
closed when nobody is listening (`packages/sdk/src/cli/run.ts:134-160`,
diagnostic `daemon_unreachable`), and `relayflowd serve` unconditionally
unlinks a leftover socket before binding
(`kernel/relayflowd/src/server.rs:50-55`). This spec adds a connection file, a
daemon-held mutex, and CLI-side attach-or-spawn.

The shape is ported from `../relay`
(`packages/cli/src/cli/lib/broker-lifecycle.ts`, `broker-connection.ts`,
`packages/harness-driver/src/broker-path.ts`): a `connection.json` written by
the server, validated by the client, detached spawn, bounded readiness poll,
attach-or-spawn on every command. The TCP parts of that design — port
allocation, `url`, `api_key` — have no analogue here. A unix socket path is
fixed by `--data-dir` and carries OS-level access control, so there is nothing
to negotiate and no secret to hand over.

**The governing rule: the socket is the authority; `connection.json` is an
index over it.** This is the same relationship `server.rs:150-200` already
states between the journal and the `runs` registry, and it decides every
ambiguous case below. A file is never believed on its own.

---

## 1. The connection file

### Path

`<data-dir>/connection.json`, default data-dir `.relayflowd`. The data dir also
holds `relayflowd.sqlite3`, `relayflowd.lock`, and `relayflowd.log`.

**The socket itself lives OUTSIDE the data dir**, at a short hashed path
under `$XDG_RUNTIME_DIR` / `$TMPDIR` — see `kernel/relayflowd/src/socket_path.rs`
and `socketPathFor` in `packages/sdk/src/daemon-connection.ts`. The daemon and
the CLI derive the same path from the same absolute data-dir input, so §2
step 3's lexical equality still holds. This decoupling exists so a deep
working directory cannot push the full socket path past `SUN_LEN` (~104 bytes
on macOS), which used to fail the daemon at `bind(2)` before any step could
run (#262).

### Shape

```json
{
  "socket_path": "/Users/x/proj/.relayflowd/relayflowd.sock",
  "pid": 48213,
  "version": "0.1.0",
  "protocol": 0,
  "started_at_ms": 1757308800123
}
```

| Field | Type | Meaning |
|---|---|---|
| `socket_path` | string | Absolute path of the bound socket. Absolute, not relative: the reader's cwd is not the daemon's. |
| `pid` | number | The serving process. Positive integer. |
| `version` | string | `env!("CARGO_PKG_VERSION")` of the `relayflowd` crate. |
| `protocol` | number | `relayflowd_core::PROTOCOL_VERSION` (currently `0`). |
| `started_at_ms` | number | Unix ms when `bind()` returned. |

Unknown fields are ignored by readers; adding a field later is not a breaking
change. Missing or wrongly-typed required fields make the file invalid, which
is treated exactly like an absent file.

`protocol` is not decoration: it lets the CLI tell "an incompatible daemon owns
this data dir" (refuse, do not spawn a second one) from "nothing is here"
(spawn). Without it the CLI would only learn about a mismatch from `hello`,
after deciding not to spawn — which is the same answer, but reached with a
round trip on every warm start.

### When relayflowd writes it

Only after the socket accepts connections, never before. Concretely, inside
`serve` (`kernel/relayflowd/src/server.rs:47`):

1. `create_dir_all(data_dir)`.
2. **Acquire the singleton lock** (§3). Everything below happens under it.
3. Remove leftovers: unlink `relayflowd.sock` and `connection.json` if present.
   Safe here and *only* here — holding the lock proves no other daemon owns
   this data dir, so the socket inode is dead and the file is a corpse.
4. `UnixListener::bind(&socket_path)`.
5. **Write `connection.json`.**
6. `spawn_reconciler`, `spawn_liveness_sweep`, enter the accept loop.

Step 4 is the guarantee. `UnixListener::bind` performs `bind(2)` *and*
`listen(2)`; from the moment `listen(2)` returns, a peer's `connect(2)`
completes into the backlog whether or not anyone has called `accept(2)` yet.
So a reader that sees the file can always connect. Writing at step 5 rather
than later also keeps the "connectable but unadvertised" window as short as it
can be.

Step 3 is the other half of the guarantee and is easy to miss: because a
booting daemon *removes* a predecessor's `connection.json` before binding,
"file absent" is a true statement for the whole boot window. A CLI polling for
the file can therefore never read a corpse belonging to a daemon that is
already being replaced.

The write is atomic: `connection.json.tmp.<pid>` in the same directory, mode
`0600`, then `rename(2)` over `connection.json`. Readers see a whole file or no
file, never a truncated one.

### When relayflowd removes it

On clean shutdown: `SIGTERM` and `SIGINT` handlers unlink `connection.json`,
then `relayflowd.sock`, then `_exit(0)`.

Handlers must be async-signal-safe, so this is `libc::signal` +
`libc::unlink` + `libc::_exit`, not `std::fs::remove_file` (which allocates a
`CString`, and `malloc` in a signal handler can deadlock). Both paths are
converted to `CString` at startup and their raw pointers parked in
`static AtomicPtr<c_char>`; the handler reads them and calls `unlink` twice.
Roughly:

```rust
// kernel/relayflowd/src/server/lifecycle.rs
static CONNECTION_PATH: AtomicPtr<c_char> = AtomicPtr::new(null_mut());
static SOCKET_PATH: AtomicPtr<c_char> = AtomicPtr::new(null_mut());

extern "C" fn on_terminate(_signum: c_int) {
    for slot in [&CONNECTION_PATH, &SOCKET_PATH] {
        let path = slot.load(Ordering::Relaxed);
        if !path.is_null() {
            unsafe { libc::unlink(path) };   // async-signal-safe
        }
    }
    unsafe { libc::_exit(0) };
}
```

`_exit` skips destructors. That is correct, not a shortcut: the journal is
SQLite with its own durability, and any lease still open at shutdown is
recovered by the reconciler on the next start — which is already the crash
path, exercised by the existing crash-injection tests.

**`kill -9` leaves the file behind, by construction.** No handler runs. The
spec does not pretend otherwise and does not try to clean up after a hard kill
from inside the dying process. That residue is what §2 exists to detect, and
the lock in §3 is released by the OS regardless, so a hard-killed daemon never
blocks its successor.

---

## 2. The staleness check

Before trusting an existing `connection.json`, the CLI runs **both** checks.
Neither alone is sufficient.

```
readConnectionFile(dataDir):
  1. parse <dataDir>/connection.json; invalid or absent -> ABSENT
  2. shape-validate: socket_path non-empty string, pid integer > 0,
     version string, protocol integer, started_at_ms integer > 0
  3. conn.socket_path must equal resolve(join(dataDir, 'relayflowd.sock'))
     -> otherwise STALE

checkDaemon(dataDir):
  4. isProcessAlive(conn.pid)                       [check 1: cheap, negative]
  5. probeSocket(conn.socket_path): connect + hello  [check 2: authoritative]
  6. probe.protocol === PROTOCOL_VERSION
```

**Step 3 — do not trust the path in the file.** The CLI recomputes the socket
path from `--data-dir` and requires the file to agree. A file whose
`socket_path` points elsewhere is stale, not a redirect. This is the same
refusal `server.rs:170-190` already makes about journals: accepting a file on
the strength of what it says about itself is how a foreign artifact gets
adopted.

**Step 4 — `isProcessAlive`.** `process.kill(pid, 0)`; `ESRCH` means dead,
success means alive, and **`EPERM` means alive** (the process exists but is
owned by another user). `../relay`'s `isProcessRunning`
(`broker-lifecycle.ts:975-982`) treats every throw as dead; that misreads
`EPERM` as "gone" and would spawn a second daemon over a live one owned by
another user. Do not port that.

**Step 5 — `probeSocket`.** Open a `JournalClient` against `socket_path`,
`connect()`, send `hello('flows')`, close. A refused connection, a connect
timeout, or a `hello` that does not answer inside the probe timeout is a
failed probe. This is the only check that proves something is *serving*.

### The four cases, decided

| pid alive | socket answers `hello` | Verdict |
|:--:|:--:|---|
| no | no | **Stale.** Unlink `connection.json`, spawn. |
| no | yes | **Attach**, with a `connection_file_stale` warning. The socket is the authority; something is serving it. Do not spawn — binding over a live daemon is the corruption this whole document exists to prevent. |
| yes | no | **Do not attach. Spawn.** Either a daemon is mid-boot, or the pid was reused by an unrelated process. The CLI does not need to tell those apart — see §3. |
| yes | yes | **Attach.** (Protocol mismatch at step 6 refuses instead: exit 2, `daemon_protocol_mismatch`. Never spawn a second daemon over a live incompatible one.) |

Row 3 is the case the requirement names: *a stale file with a live unrelated
pid must not falsely attach*. The socket probe is what refuses it. It is also
exactly the case `../relay` gets wrong — `checkBrokerReadiness` with
`requireApi: false` (`broker-lifecycle.ts:1341-1350`) returns
`{ state: 'running' }` on pid liveness alone. We do not have a
`requireApi: false` mode. The probe is not optional.

---

## 3. Attach-or-spawn, and the race

### The mutex lives in the daemon, not the CLI

`relayflowd serve` holds an exclusive `flock(2)` on
`<data-dir>/relayflowd.lock` for its entire lifetime:

```rust
let lock = File::options().create(true).read(true).write(true)
    .mode(0o600).open(data_dir.join("relayflowd.lock"))?;
if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
    let error = io::Error::last_os_error();
    if error.kind() == io::ErrorKind::WouldBlock {
        eprintln!("relayflowd: another relayflowd is already serving {}",
                  data_dir.display());
        std::process::exit(EXIT_ALREADY_SERVING); // 3
    }
    return Err(error).context("lock data dir");
}
std::mem::forget(lock); // held until the process dies
```

`libc` is already a unix dependency of the `relayflowd` crate. No new crate.

**Why the daemon and not a CLI lock file.** A CLI-side lock only serializes
processes that agree to take it. Requirement §5 says an operator running
`relayflowd serve` by hand must keep working — and that operator takes no CLI
lock, so a CLI lock cannot stop a hand-run daemon and a CLI-spawned daemon from
both binding the same socket path. That is the actual corruption. Putting the
mutex in the daemon covers *every* way a daemon can start. And `flock` is
released by the kernel when the holder dies, including `kill -9`, so it needs
no staleness heuristic — which is precisely what a mkdir/pid lock file would
need, and why `../relay` ends up parsing `ps aux`
(`broker-lifecycle.ts:988-1000`) to clean up after its own locks.

Strategy, named: **accept-and-let-the-loser-retry** — but the loser is the
*daemon*, not the CLI. The losing daemon exits before it can touch anything;
the losing CLI simply keeps polling and attaches to the winner.

### Exit codes for `relayflowd serve`

| Exit | Meaning |
|---:|---|
| `0` | Clean shutdown via SIGTERM/SIGINT. |
| `1` | Startup failure (cannot create data dir, cannot bind, cannot write the file). |
| `3` | Lost the lock — another relayflowd is already serving this data dir. Nothing was modified. |

`3` must be distinct from `1`: it is how the spawning CLI tells "I lost a
benign race, keep polling" from "startup is broken, refuse".

### The CLI algorithm

Run before `flows run`, `flows resume`, `flows tick start`, and
`flows hn-monitor start` — every verb that opens the socket.

```
ensureDaemon(dataDir, { spawn = true, timeoutMs = 10_000 }):

  A. dataDir = resolve(dataDir)

  B. attachment = checkDaemon(dataDir)          // §2
     if attachment is ATTACH        -> return it              (warm start)
     if attachment is PROTOCOL_MISMATCH -> refuse (exit 2)
     if !spawn                      -> refuse (exit 2, daemon_unreachable)

  C. mkdirSync(dataDir, { recursive: true })
     binary = resolveRelayflowdBinary()          // §3.1; refuse if not found
     log = openSync(join(dataDir, 'relayflowd.log'), 'a')
     child = spawn(binary, ['--data-dir', dataDir, 'serve'], {
       detached: true,
       stdio: ['ignore', 'ignore', log],
       env: process.env,
       cwd: process.cwd(),
     })
     child.unref()

  D. deadline = now + timeoutMs; loop every 50ms:
       a. child exited with code 3  -> lost the race. Keep polling.
                                       Do NOT respawn. Do NOT refuse.
       b. child exited non-zero, != 3 -> refuse (exit 2, daemon_start_failed),
                                       quoting the tail of relayflowd.log
       c. attachment = checkDaemon(dataDir); if ATTACH -> return it
       d. past deadline -> refuse (exit 2, daemon_start_timeout)
```

`detached: true` puts the child in its own session and process group. Two
consequences, both required: it outlives the CLI process, and a `Ctrl-C` sent
to the CLI's process group does not reach it. `stdio` never inherits the CLI's
— a daemon holding the CLI's stdout would interleave its output with
`flows run --json`'s single report object, and would hold the pipe open after
the CLI exits, hanging anything reading it. stderr goes to
`<data-dir>/relayflowd.log` so a failed start has evidence; `../relay` writes a
dedicated `background-start-error.log` for the same reason
(`broker-lifecycle.ts:75`).

`timeoutMs` is 10s, matching `../relay`'s `DETACHED_START_READY_TIMEOUT_MS`.
The 50ms interval matches the existing loop in
`scripts/run-local-workflow.mjs:64-71`.

### The race, walked exactly

Two `flows run` invocations, empty data dir `D`:

1. Both call `checkDaemon(D)` → ABSENT. Both decide to spawn.
2. Both spawn `relayflowd serve --data-dir D`. Call them A and B.
3. A and B both `open(D/relayflowd.lock)` and call
   `flock(LOCK_EX|LOCK_NB)`. `flock` is atomic in the kernel: exactly one
   succeeds. Say A wins.
4. B gets `EWOULDBLOCK`, prints one line, exits 3. **B has unlinked nothing,
   bound nothing, written nothing** — every destructive step in `serve` is
   sequenced after the lock (§1, steps 2→3).
5. A unlinks leftovers, binds, listens, atomically renames `connection.json`
   into place.
6. CLI-A and CLI-B both poll. CLI-B observes its child exit 3 (branch D.a) and
   keeps polling rather than reporting failure. Both then see the file, both
   probe the socket successfully, both attach to A.

Result: one daemon, one socket, one journal owner, two happy CLIs. The same
walk covers a CLI racing an operator's hand-run `relayflowd serve`, and a CLI
racing a daemon that is mid-boot (row 3 of the §2 table): the CLI's child loses
the lock, exits 3, and the CLI attaches to the daemon that was already coming
up.

**This is the load-bearing simplification: because the daemon holds the mutex,
the CLI never has to be clever. Spawning when in doubt is always safe.** The
CLI never needs to identify whether a live pid is "really" a relayflowd, and
therefore never needs `ps` parsing or a process-identity field in `hello`.

### Why `hello` is not extended

An earlier draft added `pid`/`started_at_ms` to the `hello` result so the CLI
could prove the file describes the daemon actually on the socket. It is not
needed. With the lock in place, `connection.json` is written only by the daemon
holding it, and a booting daemon unlinks its predecessor's file before binding.
The only interleaving that reads daemon A's file and reaches daemon B's socket
requires reading the file after A died and before B unlinked it — and B's
socket is at the same path the CLI already recomputed and validated in §2 step
3, so attaching is correct anyway. The protocol is unchanged by this document.

### 3.1 Resolving the `relayflowd` binary

New module `packages/sdk/src/relayflowd-path.ts`, modeled on
`../relay`'s `packages/harness-driver/src/broker-path.ts`. Its multi-anchor
approach transfers directly, and the reason is the one stated in that file: a
version manager can launch Node with a minimal PATH, which is exactly when a
`which` lookup fails to see the binary the installer placed next to its
launcher. Never rely on PATH alone.

Order:

1. `RELAYFLOWD_BIN` — already this repo's convention
   (`scripts/run-local-workflow.mjs:44`). If set and executable, use it. If set
   and **not** executable, **refuse** — do not fall through. An operator who
   set it meant it, and silently ignoring it is the fallback AGENTS.md rule 4
   forbids.
2. Sibling of the running `flows` entrypoint:
   `join(dirname(realpathSync(process.argv[1])), 'relayflowd')`. This is the
   published layout — `@relayflows/runtime-linux-x64` ships `bin/flows` and
   `bin/relayflowd` side by side (`scripts/pack-release.mjs:31`). `realpathSync`
   matters: package-manager launchers expose the entrypoint as a symlink whose
   target sits in the real install tree.
3. Optional-dependency package:
   `require.resolve('@relayflows/runtime-<platform>-<arch>/package.json')` →
   `<pkgdir>/bin/relayflowd`, tried from several `createRequire` anchors —
   this module's own path, `process.argv[1]`, and
   `join(process.cwd(), 'package.json')`. Multiple anchors because a globally
   installed `flows` resolving a per-project optional dep sits outside the
   consumer's `node_modules`, which is `broker-path.ts:84-106` verbatim in its
   reasoning.
4. Source checkout: walk up from `process.cwd()` (bounded, 8 levels) to the
   nearest ancestor containing `kernel/Cargo.toml`, then
   `kernel/target/release/relayflowd`, then `kernel/target/debug/relayflowd`.
5. PATH, via `which` / `where`.

Not found → exit 2, `relayflowd_not_found`, message naming both
`@relayflows/runtime-<platform>-<arch>` and the `RELAYFLOWD_BIN` escape hatch.

---

## 4. What changes, and what is new

### New — `packages/sdk/src/daemon-lifecycle.ts`

Mirrors `../relay/packages/cli/src/cli/lib/broker-lifecycle.ts` +
`broker-connection.ts`, collapsed into one file because there is no
url/port/api_key resolution chain to own. Exports:

```ts
export interface DaemonConnection {
  socket_path: string; pid: number; version: string;
  protocol: number; started_at_ms: number;
}
export type DaemonState =
  | { kind: 'attached'; connection: DaemonConnection; warning?: string }
  | { kind: 'absent' }
  | { kind: 'stale'; reason: string }
  | { kind: 'incompatible'; protocol: number };

export function readConnectionFile(dataDir: string): DaemonConnection | null;
export function isProcessAlive(pid: number): boolean;
export async function probeSocket(socketPath: string): Promise<boolean>;
export async function checkDaemon(dataDir: string): Promise<DaemonState>;
export async function ensureDaemon(
  dataDir: string,
  options?: { spawn?: boolean; timeoutMs?: number },
): Promise<DaemonState>;
```

Injectable seams for tests, following the `deps` pattern the reference file
uses: `spawnProcess`, `killProcess`, `now`, `sleep`, `fs`. No file I/O or
process spawning is reached in unit tests.

### New — `packages/sdk/src/relayflowd-path.ts`

Binary resolution, §3.1. Split from `daemon-lifecycle.ts` so neither file
approaches the 500-line smell in AGENTS.md rule 1; each stays well under 250.

### New — `kernel/relayflowd/src/server/lifecycle.rs`

The daemon half: the `flock`, the leftover sweep, the atomic
`connection.json` write, the signal handlers. `server.rs` calls
`lifecycle::acquire(data_dir)?` before its existing unlink/bind, and
`lifecycle::publish(&socket_path, ...)` immediately after `bind`. Net change to
`server.rs` is roughly ten lines; `server.rs:50-53`'s unconditional
`remove_file` moves inside `lifecycle::acquire`, where it is guarded by the
lock.

### Changed — `packages/sdk/src/cli.ts`

`runCli` calls `ensureDaemon(parsed.dataDir)` before dispatching `run`,
`resume`, `tick`, and `hn-monitor` (currently `cli.ts:74-121`). On a refusal it
emits the existing exit-2 diagnostic shape and returns 2 — the report format
does not change, only the `kind` and the message.

New flag, parsed alongside `--data-dir`: **`--no-spawn`** (also
`FLOWS_NO_SPAWN=1`), which sets `{ spawn: false }` and restores today's exact
fail-closed behavior. This is the lever for CI that means to assert a daemon is
already present rather than conjure one.

`flows check` is untouched and stays daemon-free. It is not an omission: the
argument parser already refuses `--data-dir` on `check`
(`cli.ts:158`), so there is no data dir for it to attach to, and `checkFlow` is
a pure compile-and-preflight that never opens a socket. `flows check` keeps
working with no daemon, no binary, and no data dir at all — a property worth
keeping.

### Changed — `packages/sdk/src/cli/run.ts`

Only the `daemon_unreachable` message text (`run.ts:146-158`), which currently
tells the operator to run `relayflowd serve` by hand. With `--no-spawn` that
advice is still right; without it, reaching this branch means spawning was
tried and failed, so the message must say which of `relayflowd_not_found`,
`daemon_start_failed`, or `daemon_start_timeout` happened.

### Changed — `packages/sdk/src/journal-client.ts`

**Almost nothing, deliberately.** `connect()` stays fail-closed with no retry
and no spawn. Lifecycle is not transport: putting spawn logic in the client
would make every `AgentWorker`, tick runner, and demo silently conjure daemons
as a side effect of connecting, and would put process management inside the
module AGENTS.md rule 3 calls the boundary.

One addition: `JournalClientOptions.connectTimeoutMs` (default 2000), applied
to `connect()`. `probeSocket` runs before every command, and today `connect()`
has no timer at all while `hello` inherits the 30s request default — a socket
whose listener accepts but never answers would hang the CLI for 30 seconds
before it could decide to spawn.

---

## 5. Backward compatibility

Attach-or-spawn is an addition. Manual operation is not replaced.

- **`relayflowd serve --data-dir D` by hand, on a free data dir**: byte-for-byte
  the same observable behavior, plus it now writes `connection.json` and now
  cleans up on SIGTERM/SIGINT. Nothing it did before stops. Both argument
  orders keep working — `--data-dir` is a global clap arg
  (`main.rs:13-17`), so `relayflowd --data-dir D serve` is equally valid.
- **`flows run` against a hand-started daemon**: `readConnectionFile` finds the
  file that daemon wrote, the pid is alive, the socket answers → attach. No
  spawn, no duplicate, no signal. **The CLI never terminates a daemon** — not
  one it found, and not one it spawned. There is no `flows down` verb and this
  document does not add one.
- **`flows check`**: unchanged, still needs no daemon.
- **`flows run` with no daemon and no binary findable**: still exit 2, still a
  refusal before any journal write. The `kind` changes from
  `daemon_unreachable` to `relayflowd_not_found` and the message names the
  runtime package. Same contract, better message.
- **`scripts/run-local-workflow.mjs`**: untouched and unaffected. It spawns its
  own daemon into a fresh `mkdtemp` data dir and drives `JournalClient`
  directly, never through `ensureDaemon`. Its lock is uncontended.
- **Exit codes for `flows`**: unchanged. Every new refusal is exit 2 (refused
  before a journal write), which is what the table in `docs/SURFACE.md` §5
  already promises for an unreachable daemon.

### The one intentional behavior change

A **second** `relayflowd serve` on a data dir already being served now refuses
with exit 3 instead of unlinking the live socket and rebinding
(`server.rs:50-53`). The old behavior silently orphaned the first daemon: it
kept running, holding the journal, reachable by nobody, while the second bound
a fresh inode at the same path. That is not a contract anyone should be able to
depend on, and it is the specific corruption this design exists to prevent. It
is called out here because it is the only case where an operator sees something
they did not see before.

### Documentation that must change with this

`docs/SURFACE.md` §5 currently states "Neither verb starts the daemon
implicitly." That sentence becomes false and must be rewritten in the same
commit as the CLI change, along with a mention of `--no-spawn` and of
`relayflowd serve` remaining fully supported.

---

## 6. Tests this spec must be held to

Kernel (`cargo test --workspace`):

1. `connection.json` does not exist before `bind`, and a client that reads it
   can always connect — assert by racing a connect against the file's
   appearance, not by sleeping.
2. Clean shutdown on `SIGTERM` removes `connection.json` and the socket; exit
   code 0.
3. `SIGKILL` leaves `connection.json` behind, and the file's pid is then dead —
   the residue the CLI's §2 check must catch.
4. A second `serve` on a served data dir exits 3, and the first daemon's socket
   is still accepting afterwards. This is the anti-hijack test.
5. A `SIGKILL`ed daemon's successor starts cleanly: the `flock` is free, the
   dead socket and stale file are removed, a new file is written.
6. `connection.json` contents round-trip: `socket_path` absolute and equal to
   `<data-dir>/relayflowd.sock`, `pid` = the serving process, `protocol` =
   `PROTOCOL_VERSION`.

SDK (`npm test` in `packages/sdk`):

7. Cold start: empty data dir, no daemon → exactly one spawn, run succeeds.
8. Warm start: daemon already running → attach, **zero** spawns (assert on the
   injected `spawnProcess` seam).
9. Stale file, dead pid, dead socket → file removed, fresh daemon spawned.
10. Stale file, dead pid, **live socket** → attach, no spawn, warning emitted.
11. Live pid, dead socket (the pid-reuse case) → does **not** attach.
12. `isProcessAlive` returns `true` on `EPERM`.
13. `socket_path` disagreeing with `<data-dir>/relayflowd.sock` → stale.
14. Protocol mismatch in the file or in `hello` → exit 2, no spawn.
15. Two concurrent `ensureDaemon` calls against one empty data dir → one
     surviving daemon; the loser's child exits 3 and its CLI still attaches.
16. Spawn options assert `detached: true`, `stdio[0] === 'ignore'`,
     `stdio[1] === 'ignore'`, and `unref()` called.
17. `--no-spawn` / `FLOWS_NO_SPAWN=1` reproduces today's exit-2
     `daemon_unreachable` exactly.
18. `RELAYFLOWD_BIN` set to a non-executable path refuses rather than falling
     through to PATH.

Test 15 is the one that matters most and is the hardest to fake: it must spawn
real processes against a real temp data dir, because the property under test is
enforced by `flock(2)`, not by any code we could stub.
