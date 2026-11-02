# Devin harness verification — 2026-11-02

Scope: direct Devin agent execution, credential handling, communication environment and preflight. Devin print mode is explicitly unmetered; `llm` use is refused. No package was published.

Commands below ran from `packages/sdk` unless stated otherwise.

```sh
TMPDIR=/Users/khaliqgant/.cache/devin-harness/tmp npx vitest run tests/devin.test.ts tests/adapters tests/communication-review.test.ts tests/communication-worker.test.ts tests/communication-preflight.test.ts tests/worker-cli.test.ts tests/budget-preflight.test.ts tests/preflight.test.ts tests/cli-probe.test.ts
```

```text

 RUN  v2.1.9 /Volumes/T7/Projects/AgentWorkforce/worktrees/flows/devin-harness-20261102/packages/sdk

 ✓ tests/adapters/codex.test.ts (13 tests) 11ms
 ✓ tests/adapters/claude.test.ts (13 tests) 4ms
 ✓ tests/adapters/registry.test.ts (4 tests) 4ms
 ✓ tests/communication-review.test.ts (10 tests) 408ms
 ✓ tests/budget-preflight.test.ts (25 tests) 13ms
 ✓ tests/preflight.test.ts (70 tests) 84ms
 ✓ tests/communication-worker.test.ts (21 tests) 1947ms
 ✓ tests/communication-preflight.test.ts (13 tests) 3159ms
   ✓ managed CLI preflight > probes known CLIs with the same filtered credentials as execution 1425ms
   ✓ managed CLI preflight > does not loosen ordinary wrapper preflight or cache a managed result for an ordinary step 1022ms
   ✓ managed CLI preflight > still refuses missing executables and failed known-CLI probes 590ms
 ✓ tests/devin.test.ts (8 tests) 3568ms
   ✓ launches print mode with file input and cleans up after --version
Do the task 1244ms
   ✓ launches print mode with file input and cleans up after fail 1285ms
   ✓ checks provider auth with isolated credentials in both synchronous and asynchronous preflight 970ms
 ✓ tests/cli-probe.test.ts (18 tests) 10655ms
   ✓ returns the absolute executable selected for a bare CLI name 1529ms
   ✓ binds the canonical target of a probed executable symlink 882ms
   ✓ executes a canonical shebang target through its authored alias in both probe drivers 918ms
   ✓ normalizes a relative executable returned by PATH lookup 323ms
   ✓ keeps synchronous and asynchronous classification equal: success 769ms
   ✓ keeps synchronous and asynchronous classification equal: model denied 839ms
   ✓ keeps synchronous and asynchronous classification equal: auth denied 645ms
   ✓ keeps missing executables and unsupported identification fail closed 361ms
   ✓ uses an explicit provider environment for every probe process 403ms
   ✓ scopes delivered secrets in PATH lookup and provider probes for checked and authored steps 1060ms
   ✓ reports timeout in both drivers while the async driver leaves the loop free 549ms
   ✓ reports signal termination in both drivers 337ms
   ✓ classifies a failed claude model probe from its own output: outdated CLI 375ms
   ✓ classifies a failed claude model probe from its own output: usage limit 428ms
   ✓ classifies a failed claude model probe from its own output: rate limit 447ms
   ✓ classifies a failed claude model probe from its own output: unknown model 360ms
   ✓ classifies a failed claude model probe from its own output: unrecognised output 424ms
 ✓ tests/worker-cli.test.ts (31 tests) 37184ms
   ✓ registered CLI model defaults > passes the same priced Claude default to the real provider invocation 2482ms
   ✓ registered CLI model defaults > uses the explicitly supplied agent environment for the provider subprocess 1258ms
   ✓ registered CLI model defaults > dispatches canonical generic bytes with the preflight-proved adapter identity 715ms
   ✓ dash-leading task text > claude agent runs the task "--version" instead of parsing it as an option 1230ms
   ✓ dash-leading task text > claude agent runs the task "-v explain the flag" instead of parsing it as an option 1071ms
   ✓ dash-leading task text > codex agent runs the task "--version" instead of parsing it as an option 1080ms
   ✓ dash-leading task text > codex agent runs the task "-v explain the flag" instead of parsing it as an option 833ms
   ✓ direct transport lifecycle evidence > classifies only the exact Codex stdin lifecycle signature as retryable 557ms
   ✓ direct transport lifecycle evidence > records a signal close separately from an ordinary nonzero exit 1337ms
   ✓ direct transport lifecycle evidence > records a spawn error code without treating a missing executable as transient 334ms
   ✓ direct transport lifecycle evidence > journals classified lifecycle evidence and reports crashed instead of generic worker_error 650ms
   ✓ step discovery environment > names the run, step, attempt and an absolute data dir for a direct agent spawn 652ms
   ✓ step discovery environment > exports none of the four without a data dir, even when the worker inherited them 497ms
   ✓ wrapper discovery environment > sets the four names from the dispatch and still refuses ambient values and other secrets 482ms
   ✓ wrapper discovery environment > exports none of the four to a wrapper without a data dir, even when the worker inherited them 441ms
   ✓ custom wrapper execution identity > passes an explicit safe environment at identification and execution 496ms
   ✓ custom wrapper execution identity > refuses a wrapper symlink retarget before delivering private values 643ms
   ✓ custom wrapper execution identity > bounds wrapper execution after acknowledgement 525ms
   ✓ custom wrapper execution identity > bounds captured wrapper output 616ms
   ✓ custom wrapper execution identity > refuses a duplicate execute protocol frame 702ms
   ✓ custom wrapper execution bounds are reader-owned > resolves when a conforming wrapper leaks a stdio pipe to a background helper 1225ms
   ✓ custom wrapper execution bounds are reader-owned > resolves when the leaked helper inherits stderr only 791ms
   ✓ custom wrapper execution bounds are reader-owned > resolves when a wrapper leaks a stdio pipe and exits before identifying 3328ms
   ✓ custom wrapper execution bounds are reader-owned > journals a completionReason at the default bound when a wrapper leaks a stdio pipe 12025ms
   ✓ custom wrapper execution bounds are reader-owned > accepts an execute token and an over-8KiB payload flushed in one write 438ms
   ✓ custom wrapper execution bounds are reader-owned > accepts the same over-8KiB payload whether or not it coalesces with the execute token 1405ms
   ✓ custom wrapper execution bounds are reader-owned > still bounds an un-terminated handshake buffer and names the bound 469ms
   ✓ delivers the journaled memory pack to the real wrapper and excludes its charge from completion usage 443ms

 Test Files  11 passed (11)
      Tests  226 passed (226)
   Start at  11:45:13
   Duration  38.64s (transform 1.95s, setup 363ms, collect 8.72s, tests 57.04s, environment 1ms, prepare 719ms)
```

```sh
npm run typecheck
```

```text

> @relayflows/sdk@2.0.55 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json
```

```sh
npm run typecheck:tests
```

```text

> @relayflows/sdk@2.0.55 typecheck:tests
> tsc -p tsconfig.tests.json
```

```sh
npm run build
```

```text

> @relayflows/sdk@2.0.55 build
> tsc && node scripts/make-cli-executable.mjs
```

From the repository root (Python 3.11+). Existing interactive credentials are read only to populate a private probe home; neither the key nor provider account output is printed.

```sh
TMPDIR=/Users/khaliqgant/.cache/devin-harness/tmp /opt/homebrew/bin/python3.14 evidence/devin-harness/probe-cli.py --cli /Volumes/T7/Projects/AgentWorkforce/artifacts/devin-harness-20261102/cli/bin/devin --credentials /Users/khaliqgant/.local/share/devin/credentials.toml
```

```text
devin 3000.11.234 (92c83011d113)
none: models exit=1; not logged in
dummy_env: models exit=1; not logged in
dummy_file: models exit=1; invalid api key
existing_login_file: models exit=0; catalog received
headless exit=0; marker received=True
```

The compiled `runAgentCli` was also called with the pinned binary, `cliIdentity: devin`, a 60-second timeout, and the key in its private process environment. Exact Node command:

```sh
TMPDIR=/Users/khaliqgant/.cache/devin-harness/tmp node --input-type=module <<'JS'
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runAgentCli} from './dist/worker-cli.js';
const login=readFileSync('/Users/khaliqgant/.local/share/devin/credentials.toml','utf8');
const key=JSON.parse(login.match(/^windsurf_api_key\s*=\s*(".*")$/m)[1]);
const cwd=mkdtempSync(join(tmpdir(),'devin-live-worker-'));
try {
 const result=await runAgentCli('/Volumes/T7/Projects/AgentWorkforce/artifacts/devin-harness-20261102/cli/bin/devin',
  'Reply with exactly RELAYFLOWS_DEVIN_WORKER_READY and nothing else. Do not call tools.',undefined,undefined,
  undefined,undefined,'agent',undefined,cwd,'direct',undefined,
  {PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,DEVIN_API_KEY:key},'devin',60000);
 console.log(JSON.stringify({exit_code:result.exit_code,marker:result.stdout_tail.trim(),tokens_reported:result.tokens_input!==undefined}));
 if(result.exit_code!==0||result.stdout_tail.trim()!=='RELAYFLOWS_DEVIN_WORKER_READY')process.exitCode=1;
}finally{rmSync(cwd,{recursive:true,force:true});}
JS
```

```text
{"exit_code":0,"marker":"RELAYFLOWS_DEVIN_WORKER_READY","tokens_reported":false}
```

Mutation check: removed exactly `if (name === 'devin') return ADAPTERS.devin;` from `src/adapters/index.ts`, ran the command below, restored the original file bytes in `finally`, then reran the same command. The two launch cases fail without adapter selection and pass after restoration.

```sh
TMPDIR=/Users/khaliqgant/.cache/devin-harness/tmp node node_modules/vitest/vitest.mjs run tests/devin.test.ts -t "launches print mode"
```

```text

 RUN  v2.1.9 /Volumes/T7/Projects/AgentWorkforce/worktrees/flows/devin-harness-20261102/packages/sdk

 ❯ tests/devin.test.ts (8 tests | 2 failed | 6 skipped) 604ms
   × launches print mode with file input and cleans up after --version
Do the task 346ms
     → expected null to be +0 // Object.is equality
   × launches print mode with file input and cleans up after fail 257ms
     → expected null to be 7 // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/devin.test.ts > launches print mode with file input and cleans up after --version
Do the task
AssertionError: expected null to be +0 // Object.is equality

- Expected: 
0

+ Received: 
null

 ❯ tests/devin.test.ts:87:28
     85|   const result = await runAgentCli(f.cli, task, undefined, 'gpt-5.6-so…
     86|     'agent', undefined, f.cwd, 'direct', undefined, f.env);
     87|   expect(result.exit_code).toBe(task === 'fail' ? 7 : 0);
       |                            ^
     88|   expect(result.tokens_input).toBeUndefined();
     89|   expect(result.stdout_tail).not.toContain('devin-test-secret');

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  tests/devin.test.ts > launches print mode with file input and cleans up after fail
AssertionError: expected null to be 7 // Object.is equality

- Expected: 
7

+ Received: 
null

 ❯ tests/devin.test.ts:87:28
     85|   const result = await runAgentCli(f.cli, task, undefined, 'gpt-5.6-so…
     86|     'agent', undefined, f.cwd, 'direct', undefined, f.env);
     87|   expect(result.exit_code).toBe(task === 'fail' ? 7 : 0);
       |                            ^
     88|   expect(result.tokens_input).toBeUndefined();
     89|   expect(result.stdout_tail).not.toContain('devin-test-secret');

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯

 Test Files  1 failed (1)
      Tests  2 failed | 6 skipped (8)
   Start at  11:49:35
   Duration  2.31s (transform 636ms, setup 15ms, collect 1.45s, tests 604ms, environment 0ms, prepare 62ms)
```

```sh
TMPDIR=/Users/khaliqgant/.cache/devin-harness/tmp node node_modules/vitest/vitest.mjs run tests/devin.test.ts -t "launches print mode"
```

```text

 RUN  v2.1.9 /Volumes/T7/Projects/AgentWorkforce/worktrees/flows/devin-harness-20261102/packages/sdk

 ✓ tests/devin.test.ts (8 tests | 6 skipped) 562ms

 Test Files  1 passed (1)
      Tests  2 passed | 6 skipped (8)
   Start at  11:49:38
   Duration  1.47s (transform 346ms, setup 9ms, collect 684ms, tests 562ms, environment 0ms, prepare 36ms)
```

Linux x64 binary probes (remote `linuyc`, pinned archive checksum verified before extraction):

```sh
tailscale ssh khaliqgant@linuyc 'python3 -' < /Users/khaliqgant/.cache/devin-harness/linux-probe-run.py
```

```text
Linux x64 bundle SHA-256 verified
devin 3000.11.234 (92c83011d113)
none: models exit=1; not logged in
dummy_env: models exit=1; not logged in
dummy_file: models exit=1; invalid api key
```

The probe implementation is [probe-cli.py](probe-cli.py). The installer/non-root image evidence is in the companion Cloud PR. A full hosted Cloud flow was not launched; this is CLI/runtime and image-install evidence. Independent Codex review reported no remaining findings on the working diff after fixes.

Follow-up: pin the live harness test and probe to exactly 3000.11.234. The model-probe fixture now verifies exact arguments, the staged credential and rejection paths. The actual workspace secret value/type has not been inspected; the successful live test uses an existing CLI-login token.

```sh
TMPDIR=/Users/khaliqgant/.cache/devin-harness/tmp /opt/homebrew/bin/python3.14 - <<'PY'
import os,pathlib,subprocess,tomllib
key=tomllib.loads((pathlib.Path.home()/'.local/share/devin/credentials.toml').read_text())['windsurf_api_key']
env=dict(os.environ,DEVIN_API_KEY=key,RELAYFLOWS_REAL_DEVIN_CLI='/Volumes/T7/Projects/AgentWorkforce/artifacts/devin-harness-20261102/cli/bin/devin')
r=subprocess.run(['node','node_modules/vitest/vitest.mjs','run','tests/real-devin-adapter.test.ts','tests/devin.test.ts'],env=env)
raise SystemExit(r.returncode)
PY
```

```text

 RUN  v2.1.9 /Volumes/T7/Projects/AgentWorkforce/worktrees/flows/devin-harness-20261102/packages/sdk

 ✓ tests/devin.test.ts (9 tests) 2093ms
   ✓ launches print mode with file input and cleans up after --version
Do the task 393ms
   ✓ launches print mode with file input and cleans up after fail 522ms
   ✓ checks provider auth with isolated credentials in both synchronous and asynchronous preflight 518ms
   ✓ refuses an unavailable model and missing model-probe credentials in both preflight drivers 628ms
 ✓ tests/real-devin-adapter.test.ts (1 test) 5507ms
   ✓ runs the pinned Devin CLI through the real agent worker 5506ms

 Test Files  2 passed (2)
      Tests  10 passed (10)
   Start at  11:59:07
   Duration  5.78s (transform 323ms, setup 20ms, collect 911ms, tests 7.60s, environment 0ms, prepare 99ms)
```

From the repository root:

```sh
TMPDIR=/Users/khaliqgant/.cache/devin-harness/tmp /opt/homebrew/bin/python3.14 evidence/devin-harness/probe-cli.py --cli /Volumes/T7/Projects/AgentWorkforce/artifacts/devin-harness-20261102/cli/bin/devin
```

```text
devin 3000.11.234 (92c83011d113)
none: models exit=1; not logged in
dummy_env: models exit=1; not logged in
dummy_file: models exit=1; invalid api key
```
