# Flows PR #139 — SIGNOFF A: data/code boundary and protocol structure

## Scope

- **Exact head assessed:** `f5b8437b41e32d7ba45bb96eecf9bf8eb2aee65a`
- **Merge base:** `a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2`
- **Lens:** data/code boundary and protocol structure.
- **Authority read before assessment:** `AGENTS.md` and `docs/RFC-0001-everything-is-a-relayflow.md`.
- **Assessment-only:** no product or gate files were edited; no push or merge was performed.

## Verdict

**VERDICT: FINDINGS**

The new snapshot is correctly used by the compiler, lowering, and preflight entry paths, but the SDK still exports two adjacent `unknown`-accepting boundary functions which reflect an unsnapshotted Proxy and execute its traps. That contradicts the claimed behavior-free data boundary, including after packaging.

## Finding F1

- **ID:** F1
- **Severity:** P1
- **Title:** Public validation and reverse-boundary conversion bypass the behavior-free snapshot.
- **Locations:** `sdk/src/validate.ts:81-92`, `sdk/src/compile.ts:187-324`, exports in `sdk/src/index.ts:31-40`.
- **Impact:** A local SDK caller can supply a Proxy as a declared flow/kernel-spec object. `validateSpec` and `kernelToAuthoring` call reflective operations (`Object.keys` and property reads) on it, executing author-controlled proxy traps before refusing or normalizing it. `validateSpec` additionally reports that Proxy as valid. This is code execution in what the PR defines as a serializable data boundary, so it cannot meet the zero-traps-before-reflection/probes contract.
- **Required repair:** Route both exported `unknown`-accepting functions through one behavior-free snapshot before their first `Array.isArray`, `Object.keys`, `Reflect.*`, descriptor, or property operation (or make the unsafe conversion non-public and restrict it to parsed JSON). Add Node, Bun, and packed-install regression tests covering every exported boundary.

### Reproduction — source build in Node and Bun

Command:

```sh
for runtime in node bun; do "$runtime" --input-type=module -e 'import {compileSpec, validateSpec, kernelToAuthoring} from "./dist/index.js"; const valid={version:"0.1.0",steps:[{id:"s",type:"deterministic",command:"true"}]}; for (const [name, fn] of [["compileSpec", compileSpec],["validateSpec", validateSpec],["kernelToAuthoring", kernelToAuthoring]]) { let traps=0; const proxy=new Proxy(valid,{ownKeys(t){traps++; return Reflect.ownKeys(t)},getOwnPropertyDescriptor(t,k){traps++; return Reflect.getOwnPropertyDescriptor(t,k)}}); try { const result=fn(proxy); console.log(name,"returned",JSON.stringify(result).slice(0,80),"traps="+traps); } catch (error) { console.log(name,"threw",error.constructor.name,"traps="+traps,"message="+error.message.split("\n")[0]); }}'; done
```

Captured output:

```text
compileSpec threw CompileError traps=0 message=spec compile failed:
validateSpec returned {"ok":true,"errors":[]} traps=3
kernelToAuthoring returned {"version":"0.1.0","steps":[{"id":"s","type":"deterministic","command":"true"}]} traps=3
compileSpec threw CompileError traps=0 message=spec compile failed:
validateSpec returned {"ok":true,"errors":[]} traps=3
kernelToAuthoring returned {"version":"0.1.0","steps":[{"id":"s","type":"deterministic","command":"true"}]} traps=3
```

The first three lines are Node; the identical next three are Bun.

### Reproduction — packed, installed SDK

Command:

```sh
review_tmp=$(mktemp -d /tmp/pr139-installed.XXXXXX); tarball=$(bun pm pack --destination "$review_tmp" --ignore-scripts --quiet); cd "$review_tmp"; bun init -y >/dev/null; bun add "$tarball" --ignore-scripts >/dev/null; node --input-type=module -e 'import {compileSpec, validateSpec, kernelToAuthoring} from "@relayflows/sdk"; const valid={version:"0.1.0",steps:[{id:"s",type:"deterministic",command:"true"}]}; for (const [name, fn] of [["compileSpec", compileSpec],["validateSpec", validateSpec],["kernelToAuthoring", kernelToAuthoring]]) { let traps=0; const proxy=new Proxy(valid,{ownKeys(t){traps++; return Reflect.ownKeys(t)},getOwnPropertyDescriptor(t,k){traps++; return Reflect.getOwnPropertyDescriptor(t,k)}}); try { const result=fn(proxy); console.log(name,"returned",JSON.stringify(result).slice(0,80),"traps="+traps); } catch (error) { console.log(name,"threw",error.constructor.name,"traps="+traps,"message="+error.message.split("\n")[0]); }}'; printf 'INSTALLED_TARBALL=%s\n' "$tarball"; printf 'INSTALLED_TEMP=%s\n' "$review_tmp"
```

Captured output:

```text
Resolving dependencies
Resolved, downloaded and extracted [0]
Saved lockfile
Resolving dependencies
Resolved, downloaded and extracted [11]
Saved lockfile
compileSpec threw CompileError traps=0 message=spec compile failed:
validateSpec returned {"ok":true,"errors":[]} traps=3
kernelToAuthoring returned {"version":"0.1.0","steps":[{"id":"s","type":"deterministic","command":"true"}]} traps=3
INSTALLED_TARBALL=/tmp/pr139-installed.Gvz6gI/relayflows-sdk-0.1.0.tgz
INSTALLED_TEMP=/tmp/pr139-installed.Gvz6gI
```

## Verified passes (non-dispositive)

### PASS P1 — compiler/lowering/preflight use the snapshot correctly

- **Claim:** On both Node and Bun, these covered public paths preserve ordinary explicit-`undefined` object optional compatibility, reject array `undefined` and behavioral/non-JSON values, reject a non-deterministic `exit_code` gate, preserve both boolean schemas, and reject a Proxy before any probe or Proxy trap.
- **Command:**

```sh
for runtime in node bun; do "$runtime" --input-type=module -e 'import {compileSpec, toKernelSpec, preflight} from "./dist/index.js"; const out=[]; const base={version:"0.1.0",description:undefined,steps:[{id:"d",type:"deterministic",command:"true",verification:undefined}]}; const compiled=compileSpec(base); out.push(`undefined_omitted=${!("description" in compiled)} implicit_exit=${compiled.steps[0].verification.type}`); const accessor={};Object.defineProperty(accessor,"x",{enumerable:true,get(){throw new Error("ran")}});const cyclic={};cyclic.self=cyclic; const bad=[["array_undefined",{version:"0.1.0",steps:[undefined]}],["callback",{version:"0.1.0",steps:[{id:"d",type:"deterministic",command:"true",verification:()=>true}]}],["accessor",{version:"0.1.0",steps:[{id:"d",type:"deterministic",command:"true",verification:{type:"json_schema",schema:accessor}}]}],["bigint",{version:"0.1.0",steps:[{id:"d",type:"deterministic",command:"true",verification:{type:"json_schema",schema:{x:1n}}}]}],["cycle",{version:"0.1.0",steps:[{id:"d",type:"deterministic",command:"true",verification:{type:"json_schema",schema:cyclic}}]}],["llm_exit",{version:"0.1.0",steps:[{id:"l",type:"llm",prompt:"p",verification:{type:"exit_code"}}]}]]; for (const [name,value] of bad) {try {compileSpec(value);out.push(`${name}=UNEXPECTED`)}catch{out.push(`${name}=refused`)}} for (const schema of [true,false]) {const k=toKernelSpec(compileSpec({version:"0.1.0",steps:[{id:"l",type:"llm",prompt:"p",verification:{type:"json_schema",schema}}]}));out.push(`boolean_${schema}=${k.steps[0].verification.json_schema===schema}`)} let probes=0;const proxy=new Proxy({version:"0.1.0",steps:[{id:"d",type:"deterministic",command:"true"}]},{ownKeys(t){probes++;return Reflect.ownKeys(t)},getOwnPropertyDescriptor(t,k){probes++;return Reflect.getOwnPropertyDescriptor(t,k)}});try{preflight(proxy,{probes:{command(){throw new Error("probe")},cli(){throw new Error("probe")},executor(){throw new Error("probe")}}})}catch(e){out.push(`preflight_proxy_refused=${/proxy/i.test(e.message)} proxy_traps=${probes}`)} console.log(out.join(" "))'; done
```

- **Captured output:**

```text
undefined_omitted=true implicit_exit=exit_code array_undefined=refused callback=refused accessor=refused bigint=refused cycle=refused llm_exit=refused boolean_true=true boolean_false=true preflight_proxy_refused=true proxy_traps=0
undefined_omitted=true implicit_exit=exit_code array_undefined=refused callback=refused accessor=refused bigint=refused cycle=refused llm_exit=refused boolean_true=true boolean_false=true preflight_proxy_refused=true proxy_traps=0
```

### PASS P2 — focused SDK regression suite

- **Claim:** The added SDK tests pass under Bun's Vitest runner.
- **Command:**

```sh
bun run build && bunx vitest run tests/gate-contract.test.ts tests/preflight.test.ts
```

- **Captured output:**

```text
$ tsc && node scripts/make-cli-executable.mjs

 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-pr139-signoff-a-wt/sdk

 ✓ tests/preflight.test.ts (15 tests) 78ms
 ✓ tests/gate-contract.test.ts (13 tests) 189ms

 Test Files  2 passed (2)
      Tests  28 passed (28)
   Start at  21:39:21
   Duration  2.86s (transform 939ms, setup 0ms, collect 1.98s, tests 267ms, environment 0ms, prepare 1.15s)
```

### PASS P3 — implementation order for socket preflight

- **Claim:** The socket implementation maps an `Engine::start` error carrying `SpecError` to `invalid_spec`; `Engine::start_with_options` calls `spec.validate()` before `SqliteJournal::create` and registry registration. The dedicated real-Unix-socket test encodes command, journal, registry, and error-code assertions in `kernel/relayflowd/tests/invalid_schema_preflight.rs`.
- **Evidence inspected:** `kernel/relayflowd/src/server.rs:165-171`, `kernel/relayflowd/src/server.rs:490-496`, `kernel/relayflowd/src/engine.rs:99-124`, `kernel/relayflowd/tests/invalid_schema_preflight.rs:20-83`.
- **Command:**

```sh
CARGO_TARGET_DIR=/tmp/pr139-cargo.Aitx8y cargo test --locked -p relayflowd --test invalid_schema_preflight -- --nocapture
```

- **Captured output:**

```text
    Finished `test` profile [unoptimized + debuginfo] target(s) in 1.41s
     Running tests/invalid_schema_preflight.rs (/tmp/pr139-cargo.Aitx8y/debug/deps/invalid_schema_preflight-bb9367af18e074b7)

running 1 test
test invalid_json_schema_is_refused_before_journal_or_command ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.01s
```

## Repository cleanliness

Command:

```sh
git status --short && git diff --check a0d42ffbdc7fb60b42c0b5bea4f58408249b08a2..HEAD && git diff --check
```

Captured output:

```text
```

Only this review report is staged by this assessment.

VERDICT: FINDINGS
