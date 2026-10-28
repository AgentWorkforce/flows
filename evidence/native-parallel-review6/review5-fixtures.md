# #667 review 5: exact fixtures for Q5, Q5n, Q5h, Q5w, Q5wn, Q5wh, Q6Pw

These are byte-for-byte expansions of the scenario generator I ran (`scenarios.mjs`/`h.mjs`, reconstructed from the review-5 transcript, where the generator source appears verbatim). I am not aware of any byte I cannot vouch for. The only things that differ per run are the absolute fixture directory (`<dir>`) and the stdout of the commands.

Head under test: `78e7d1fcc0bf58ade55b13c68c347c312b7f85f5`.

## Environment as run

- Docker `node:22-trixie` (Node v22.23.3), started with `--init`, x86_64 Linux VM on Docker Desktop.
- **Kernel:** `relayflowd` built in the container from flows `5de41849` (main, v2.0.51; head's kernel is byte-identical) with `cargo build -p relayflowd` (dev profile). Binary: `/w/target-main/debug/relayflowd`. The 2.0.50 runs used a kernel built the same way from `da6eeb3f`.
- **Head CLI:** `packages/sdk` at head, `npm ci && npm run build`, CLI `/w/head/packages/sdk/dist/cli.js`, node_modules `/w/head/packages/sdk/node_modules` (`@relayflows/surface` 2.0.51). Built `dist/authored-parallel-eligibility.js` SHA-256 `682ca6b984deaaaa23e916655688566d841821bc0622b676092abfe92f545634`.
- **Base CLI:** the same build from `5de41849`. The 2.0.50 runs used `npm install @relayflows/sdk@2.0.50` and its `dist/cli.js`.
- `sqlite3` CLI was installed for the journal read-back.
- Up to 3 fixtures ran concurrently (harness `--conc=3`), alongside other scenario batches.

## Files common to every fixture (`<dir>` is the fixture root)

`<dir>/package.json`:
```json
{"type":"module"}
```

`<dir>/node_modules` is a symlink to the CLI side's node_modules (head: `/w/head/packages/sdk/node_modules`). The symlink lives in a scratch fixture directory, not a worktree.

`<dir>/flows.json` (written by the harness, not used by these shell-only flows):
```json
{"cli":"<dir>/adapter.mjs","models":["test-model"]}
```

`<dir>/adapter.mjs`, chmod 755, never invoked by these flows (`calls.jsonl` stayed empty):
```js
#!/usr/bin/env node
import { receiveWrapperRequest } from '/w/head/testdata/preflight/wrapper-session.mjs';
import { appendFileSync } from 'node:fs';
if (process.argv[2] === 'auth') process.exit(0);
const request = await receiveWrapperRequest();
if (request) {
  appendFileSync("<dir>/calls.jsonl", JSON.stringify({ instruction: request.instruction.split('\n')[0] }) + '\n');
  process.stdout.write("{\"message\":\"hello from llm\"}");
}
```

## Q5 (re-export chain, group in the first turn)

`<dir>/chain.flow.ts`:
```ts
export { default } from './impl.ts';
```

`<dir>/impl.ts`:
```ts
import { flow } from '@relayflows/surface';
const Promise = { all: globalThis.Promise.all.bind(globalThis.Promise) };
export default flow('q5', async f => {
  await Promise.all([f.run('sleep 0.5; printf A'), f.run('printf B'), f.run('sleep 0.1; printf C')]);
  await f.run('printf X >> effects');
  await f.run('test -f release || { touch stalled; sleep 120; }; printf Z >> effects', { timeout: '5m' });
  f.done('success');
});
```

## Q5n (re-export chain, Native shape, group in the first turn)

`<dir>/chain.flow.ts`:
```ts
export { default } from './impl.ts';
```

`<dir>/impl.ts`:
```ts
import { flow } from '@relayflows/surface';
const Promise = { all: globalThis.Promise.all.bind(globalThis.Promise) };
export default flow('q5n', async f => {
  const a = async () => { await f.run('sleep 0.4; printf A'); await f.run('printf a >> effects'); };
  const b = async () => { await f.run('printf B'); await f.run('printf b >> effects'); };
  const c = async () => { await f.run('sleep 0.2; printf C'); await f.run('printf c >> effects'); };
  await Promise.all([a(), b(), c()]);
  await f.run('printf X >> effects');
  await f.run('test -f release || { touch stalled; sleep 120; }; printf Z >> effects', { timeout: '5m' });
  f.done('success');
});
```

## Q5h (re-export chain, hand-written all, group in the first turn)

`<dir>/chain.flow.ts`:
```ts
export { default } from './impl.ts';
```

`<dir>/impl.ts`:
```ts
import { flow } from '@relayflows/surface';
const Promise = { all: (xs) => new globalThis.Promise((res, rej) => { const out = []; let n = xs.length; xs.forEach((x, i) => globalThis.Promise.resolve(x).then(v => { out[i] = v; if (--n === 0) res(out); }, rej)); }) };
export default flow('q5h', async f => {
  await Promise.all([f.run('sleep 0.5; printf A'), f.run('printf B'), f.run('sleep 0.1; printf C')]);
  await f.run('printf X >> effects');
  await f.run('test -f release || { touch stalled; sleep 120; }; printf Z >> effects', { timeout: '5m' });
  f.done('success');
});
```

## Q5w (re-export chain, group after a first step), the 6/6 replay

`<dir>/chain.flow.ts`:
```ts
export { default } from './impl.ts';
```

`<dir>/impl.ts`:
```ts
import { flow } from '@relayflows/surface';
const Promise = { all: globalThis.Promise.all.bind(globalThis.Promise) };
export default flow('q5w', async f => {
  await f.run('sleep 0.2; printf W');
  await Promise.all([f.run('sleep 0.5; printf A'), f.run('printf B'), f.run('sleep 0.1; printf C')]);
  await f.run('printf X >> effects');
  await f.run('test -f release || { touch stalled; sleep 120; }; printf Z >> effects', { timeout: '5m' });
  f.done('success');
});
```

## Q5wn (re-export chain, Native shape, group after a first step)

`<dir>/chain.flow.ts`:
```ts
export { default } from './impl.ts';
```

`<dir>/impl.ts`:
```ts
import { flow } from '@relayflows/surface';
const Promise = { all: globalThis.Promise.all.bind(globalThis.Promise) };
export default flow('q5wn', async f => {
  await f.run('sleep 0.2; printf W');
  const a = async () => { await f.run('sleep 0.4; printf A'); await f.run('printf a >> effects'); };
  const b = async () => { await f.run('printf B'); await f.run('printf b >> effects'); };
  const c = async () => { await f.run('sleep 0.2; printf C'); await f.run('printf c >> effects'); };
  await Promise.all([a(), b(), c()]);
  await f.run('printf X >> effects');
  await f.run('test -f release || { touch stalled; sleep 120; }; printf Z >> effects', { timeout: '5m' });
  f.done('success');
});
```

## Q5wh (re-export chain, hand-written all, group after a first step)

`<dir>/chain.flow.ts`:
```ts
export { default } from './impl.ts';
```

`<dir>/impl.ts`:
```ts
import { flow } from '@relayflows/surface';
const Promise = { all: (xs) => new globalThis.Promise((res, rej) => { const out = []; let n = xs.length; xs.forEach((x, i) => globalThis.Promise.resolve(x).then(v => { out[i] = v; if (--n === 0) res(out); }, rej)); }) };
export default flow('q5wh', async f => {
  await f.run('sleep 0.2; printf W');
  await Promise.all([f.run('sleep 0.5; printf A'), f.run('printf B'), f.run('sleep 0.1; printf C')]);
  await f.run('printf X >> effects');
  await f.run('test -f release || { touch stalled; sleep 120; }; printf Z >> effects', { timeout: '5m' });
  f.done('success');
});
```

## Q6Pw (imported module patches Promise.all after the observer is installed)

`<dir>/chain.flow.ts`:
```ts
import { flow } from '@relayflows/surface';
import './lib/patch.mjs';
export default flow('q6Pw', async f => {
  await f.run('sleep 0.3; printf W');
  const a = async () => { await f.run('sleep 0.4; printf A'); await f.run('printf a >> effects'); };
  const b = async () => { await f.run('printf B'); await f.run('printf b >> effects'); };
  const c = async () => { await f.run('sleep 0.2; printf C'); await f.run('printf c >> effects'); };
  await Promise.all([a(), b(), c()]);
  await f.run('printf X >> effects');
  await f.run('test -f release || { touch stalled; sleep 120; }; printf Z >> effects', { timeout: '5m' });
  f.done('success');
});
```

`<dir>/lib/patch.mjs`:
```js
const I = Function('return this')()['Pro' + 'mise'];
const intrinsicAll = I.all;
const t = setInterval(() => { if (I.all !== intrinsicAll) { clearInterval(t); I.all = function all(xs) { return intrinsicAll.call(I, xs); }; } }, 2);
t.unref();
```

## Driver steps (identical for every scenario above)

For repetition `i` in 0..5, with `DELAYS = [0, 60, 130, 220, 330, 450]`:

1. **Create the fixture.** `rm -rf <dir>; mkdir -p <dir>` and write the files above. `<dir>` was `/w/runs/<scenario>/<start>-<resume>-<i>`.
2. **Start the run asynchronously** with cwd `<dir>` and env = the container env plus `RELAYFLOWD_BIN=<kernel>`:
   ```sh
   node <cli> run --no-observer-link --json --data-dir <dir>/data <dir>/chain.flow.ts --input '{}'
   ```
   There was no `--local-agent` flag. The CLI starts the daemon itself.
3. **Wait for the stall.** Poll every 15 ms for `<dir>/stalled`, up to 90 s, or until the CLI exits.
   - If the CLI exits first, the run is a fresh-run outcome: record its exit code and diagnostics (this is where Q5/Q5n/Q5h stop at head).
4. **Kill.** Once `stalled` exists:
   - Sleep `DELAYS[i]` ms, then SIGKILL the CLI and wait up to 2 s for it to exit.
   - SIGKILL the daemon pid read from `<dir>/data/connection.json`, plus every process whose `/proc/<pid>/cwd` starts with `<dir>` or whose `/proc/<pid>/cmdline` contains `<dir>`. This catches the `sleep 120` shell.
   - Sleep 100 ms and repeat that whole kill sweep once.
5. **Release.** Create an empty `<dir>/release`.
6. **Find the root run id.** List `<dir>/data/runs/*.sqlite3` sorted by name (ULID). For each, read `select payload from entries where entry_type='run.spawned' order by seq limit 1`. The root is the first one whose `spec.steps[0].id === 'authored-root'`. The same read gave the mode (`JSON.parse(spec.steps[0].instruction).executionMode`).
7. **Resume synchronously,** same cwd and env, 150 s timeout:
   ```sh
   node <cli> resume --no-observer-link --json --data-dir <dir>/data <rootRunId>
   ```
8. **Clean up.** Repeat the kill sweep from step 4, then read the results.

Start and resume used the same side: head/head, main/main, or 2.0.50/2.0.50.

## Assertions

- **Effects:** read `<dir>/effects`. Only the shell commands that append to `effects` count; W/A/B/C print to stdout only.
- **Replay (primary):** any letter appears more than once.
- **Replay (journal cross-check):**
  - For every child run (each non-root `*.sqlite3`), take the first `run.spawned` `spec.steps[0].command` and its step id.
  - Count `step.completed` entries with `select count(*) from entries where entry_type='step.completed'`.
  - A replay is flagged when the same command appears under two different step ids and at least one of them completed.
- **Pass:** the resume exits 0 and neither replay check fires.
- **Expected effects.** Head printed the same letters, in branch completion order such as `bcaXZ`.

  | Scenario | Effects with no replay |
  |---|---|
  | Q5, Q5h, Q5w, Q5wh | `XZ` |
  | Q5n, Q5wn, Q6Pw | `abcXZ` |

- **Observed at head:**

  | Scenario | Result |
  |---|---|
  | Q5w | `XXZ` 6/6, resume exit 0. Journal: `printf X >> effects` admitted as `run-after-caf9…-1` on the first run and `run-after-2477…-1` on resume. |
  | Q5wn | `bcaXXZ` 5/6, resume exit 0 |
  | Q5wh | `XXZ` 5/6, resume exit 0 |
  | Q6Pw | `bcaXXZ` 5/6, resume exit 0 |
  | Q5, Q5n, Q5h | no stall; the fresh `run` exits 1 with `diagnostics[].kind = "step_failed"` and the message `cannot assign a replay-stable f.run identity: its causal frontier passes through an unregistered aggregate`. Q5n had already appended `bca`. |

  Base 2.0.51 passed all seven 6/6. 2.0.50 passed Q5w and Q5wn 6/6 (the others were not run on 2.0.50).

## Notes for reproducing

- **Q6Pw timing:** this scenario depends on the patch landing during the 0.3 s `W` step on the first run, and the resume's memoized `W` reaching the group before the 2 ms interval fires. I saw 5/6 replays with the delays above under concurrency 3.
- **Q6Pw without `W`:** Q6P, the same patch with no first step, passes 6/6, because the group is called in the first turn before the patch.
- **Replay rates:** the re-export replays (Q5w/Q5wn/Q5wh) depend only on which member settles last on resume versus the first run. They do not depend on the kill delay.
