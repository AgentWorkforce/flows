// Pins the real adapter (runAgentWithCli + spawnCapture + artifact diff +
// RELAYFLOW_MODEL + preflight) against a scripted stub binary, so the logic
// every gate depends on is tested without spending a token. The stub speaks
// each CLI's verified output shape (see shims/headless.ts header) and takes
// its behaviour from environment variables set per test.
//
//   node --experimental-strip-types --test examples/research/tests/adapter.test.ts

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStepFailed, runAgentWithCli, workspaceDir } from "../shims/agent-cli.ts";
import { PROBE_PROMPT, preflightHeadless, type HeadlessBinaries } from "../shims/headless.ts";
import { main, runResearch } from "../shims/run.ts";

// One stub serves all three CLIs. It ignores its flags, writes whatever
// STUB_WRITE names into the workspace (STUB_DIR), then prints the structured
// final output for STUB_CLI, embedding RELAYFLOW_MODEL so a test can see
// what the child received. STUB_EXIT / STUB_EMPTY / STUB_NO_USAGE flip the
// failure paths.
const STUB = `#!/bin/sh
# claude auth status / codex login status / grok --version probes
case "$1" in
  auth|login) [ "\${STUB_AUTH_FAIL:-0}" = "1" ] && exit 1; echo '{"loggedIn": true}'; exit 0;;
esac
[ -n "\${STUB_ARGV_FILE:-}" ] && printf '%s\\n' "$@" > "$STUB_ARGV_FILE"
# Live round-trip probe: recognised by the probe prompt appearing as an
# argument. Honour a model flag: STUB_MODEL_FAIL names a model the stub
# "cannot resolve". One output line satisfies all three parsers.
MODEL_ARG=""; prev=""
for a in "$@"; do [ "$prev" = "--model" ] || [ "$prev" = "-m" ] && MODEL_ARG="$a"; prev="$a"; done
for a in "$@"; do
  if [ "$a" = "$STUB_PROBE_PROMPT" ]; then
    [ "\${STUB_AUTH_FAIL:-0}" = "1" ] && exit 1
    [ -n "\${STUB_MODEL_FAIL:-}" ] && [ "$MODEL_ARG" = "$STUB_MODEL_FAIL" ] && { echo "error: unknown model $MODEL_ARG" >&2; exit 1; }
    [ "\${STUB_PROBE_SILENT:-0}" = "1" ] && { echo '{"type":"item.completed","item":{"type":"agent_message","text":""},"result":"","is_error":false,"text":""}'; exit 0; }
    [ -n "\${STUB_PROBE_TEXT:-}" ] && { printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"},"result":"%s","is_error":false,"text":"%s"}\\n' "$STUB_PROBE_TEXT" "$STUB_PROBE_TEXT" "$STUB_PROBE_TEXT"; exit 0; }
    echo '{"type":"item.completed","item":{"type":"agent_message","text":"OK"},"result":"OK","is_error":false,"text":"OK"}'; exit 0
  fi
done
# Optional: become a long-running agent (records pid, then sleeps) so a test
# can interrupt the entry point while agents are live.
if [ "\${STUB_SLEEP:-0}" = "1" ]; then echo $$ >> "$STUB_PIDFILE"; exec sleep 30; fi
# Optional: wait (up to 5s) until a file has N lines, so a test can make the
# failing lane fail only after its siblings are demonstrably running.
if [ -n "\${STUB_WAIT_FILE:-}" ]; then
  i=0; while [ "$(wc -l < "$STUB_WAIT_FILE" 2>/dev/null | tr -d ' ')" != "\${STUB_WAIT_LINES:-2}" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
fi
[ -n "\${STUB_WRITE:-}" ] && printf '%s\\n' "\${STUB_CONTENT:-written}" > "$STUB_DIR/$STUB_WRITE"
[ -n "\${STUB_STRAY:-}" ] && printf 'stray\\n' > "$STUB_DIR/$STUB_STRAY"
MODEL="\${RELAYFLOW_MODEL-<unset>}"
TEXT="done model=$MODEL"
[ "\${STUB_EMPTY:-0}" = "1" ] && TEXT=""
USAGE='"usage":{"input_tokens":7,"output_tokens":3,"cache_read_input_tokens":1}'
[ "\${STUB_NO_USAGE:-0}" = "1" ] && USAGE='"nousage":true'
case "$STUB_CLI" in
  claude)
    echo '{"type":"system","subtype":"init","session_id":"s-claude"}'
    printf '{"type":"result","subtype":"success","is_error":false,"result":"%s","session_id":"s-claude","total_cost_usd":0.5,%s,"subagent_stats":{"spawned":2}}\\n' "$TEXT" "$USAGE";;
  codex)
    echo '{"type":"thread.started","thread_id":"t-codex"}'
    printf '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"%s"}}\\n' "$TEXT"
    printf '{"type":"turn.completed",%s}\\n' "$(echo "$USAGE" | sed 's/cache_read_input_tokens/cached_input_tokens/')";;
  grok)
    printf 'notice line\\n{"text":"%s","sessionId":"g-grok","total_cost_usd":0.25,%s}\\n' "$TEXT" "$USAGE";;
esac
exit "\${STUB_EXIT:-0}"
`;

interface Rig { root: string; ws: string; binaries: HeadlessBinaries; stub: string }

async function rig(): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), "research-adapter-"));
  const stub = join(root, "stub-cli");
  await writeFile(stub, STUB, "utf8");
  await chmod(stub, 0o755);
  const ws = join(root, "ws");
  await mkdir(ws);
  return { root, ws, binaries: { claude: stub, codex: stub, grok: stub }, stub };
}

// The stub learns the probe prompt from the environment so the test and the
// adapter cannot drift on its wording.
process.env["STUB_PROBE_PROMPT"] = PROBE_PROMPT;

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return fn().finally(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

for (const cli of ["claude", "codex", "grok"] as const) {
  test(`${cli}: artifacts are the top-level files the agent wrote, minus the shim's own files; usage, session, trajectory recorded`, async () => {
    const r = await rig();
    try {
      // A pre-existing file with unchanged content must NOT be an artifact.
      await writeFile(join(r.ws, "old.md"), "old", "utf8");
      const result = await withEnv({ STUB_CLI: cli, STUB_DIR: r.ws, STUB_WRITE: "report.md", RELAYFLOW_MODEL: "leaked-from-host" }, () =>
        runAgentWithCli({ name: cli, definition: { cli, model: "m-declared" }, task: "do it", workspace: `${r.ws}: readwrite`, cwd: r.root, timeoutMs: 10_000, binaries: r.binaries }));
      assert.deepEqual(result.artifacts, [join(r.ws, "report.md")], "only the agent's new file; not old.md, not <name>.prompt.md/.log/.trajectory.jsonl");
      assert.equal(result.summary, "done model=m-declared", "declared model reaches the child as RELAYFLOW_MODEL, overriding the host's");
      assert.equal(result.usage?.inputTokens, 7);
      assert.equal(result.usage?.outputTokens, 3);
      assert.equal(result.sessionId, cli === "claude" ? "s-claude" : cli === "codex" ? "t-codex" : "g-grok");
      assert.ok(result.trajectory?.endsWith(`${cli}.trajectory.jsonl`));
      const events = (await readFile(result.trajectory!, "utf8")).trim().split("\n");
      assert.ok(events.length >= 1 && events.every((line) => JSON.parse(line)), "trajectory is JSONL of the parsed events");
      if (cli === "claude") assert.deepEqual(result.subagents, { spawned: 2 });
      const prompt = await readFile(join(r.ws, `${cli}.prompt.md`), "utf8");
      assert.equal(prompt, "do it", "the task is written to the prompt file, never argv");
      assert.match(await readFile(join(r.ws, `${cli}.log`), "utf8"), /--- completionReason: success/u);
    } finally { await rm(r.root, { recursive: true, force: true }); }
  });
}

test("the task never travels on argv: the stub dumps its argv and the brief text is not in it", async () => {
  const r = await rig();
  try {
    const argvFile = join(r.root, "argv");
    const task = `do it ${"very long question ".repeat(300)}`;
    for (const cli of ["claude", "codex", "grok"] as const) {
      await withEnv({ STUB_CLI: cli, STUB_DIR: r.ws, STUB_WRITE: "report.md", STUB_ARGV_FILE: argvFile }, () =>
        runAgentWithCli({ name: cli, definition: { cli, model: "m" }, task, workspace: `${r.ws}: readwrite`, cwd: r.root, timeoutMs: 10_000, binaries: r.binaries }));
      const argv = (await readFile(argvFile, "utf8")).split("\n");
      assert.ok(!argv.some((a) => a.includes("very long question")), `${cli}: argv must not carry the task`);
      assert.ok(argv.length < 20, `${cli}: argv is a fixed short flag set, got ${argv.length} entries`);
    }
  } finally { await rm(r.root, { recursive: true, force: true }); }
});

test("no declared model: RELAYFLOW_MODEL is ABSENT in the child even if the host has it set", async () => {
  const r = await rig();
  try {
    const result = await withEnv({ STUB_CLI: "claude", STUB_DIR: r.ws, RELAYFLOW_MODEL: "leaked-from-host" }, () =>
      runAgentWithCli({ name: "claude", definition: { cli: "claude" }, task: "t", workspace: `${r.ws}: readwrite`, cwd: r.root, timeoutMs: 10_000, binaries: r.binaries }));
    assert.equal(result.summary, "done model=<unset>");
  } finally { await rm(r.root, { recursive: true, force: true }); }
});

test("a stray top-level file written by the agent IS an artifact, so the gate can see undeclared writes inside the workspace", async () => {
  const r = await rig();
  try {
    const result = await withEnv({ STUB_CLI: "codex", STUB_DIR: r.ws, STUB_WRITE: "report.md", STUB_STRAY: "notes.txt" }, () =>
      runAgentWithCli({ name: "codex", definition: { cli: "codex" }, task: "t", workspace: `${r.ws}: readwrite`, cwd: r.root, timeoutMs: 10_000, binaries: r.binaries }));
    assert.deepEqual(result.artifacts, [join(r.ws, "notes.txt"), join(r.ws, "report.md")]);
  } finally { await rm(r.root, { recursive: true, force: true }); }
});

test("non-zero exit, empty final message, and missing usage are each worker_error, never an empty success", async () => {
  const r = await rig();
  try {
    const base = { name: "grok" as const, definition: { cli: "grok" }, task: "t", workspace: `${r.ws}: readwrite`, cwd: r.root, timeoutMs: 10_000, binaries: r.binaries };
    await assert.rejects(withEnv({ STUB_CLI: "grok", STUB_DIR: r.ws, STUB_EXIT: "3" }, () => runAgentWithCli(base)),
      (e: unknown) => e instanceof AgentStepFailed && e.completionReason === "worker_error" && /exited 3/u.test(e.message));
    await assert.rejects(withEnv({ STUB_CLI: "grok", STUB_DIR: r.ws, STUB_EMPTY: "1" }, () => runAgentWithCli(base)),
      (e: unknown) => e instanceof AgentStepFailed && e.completionReason === "worker_error" && /missing or empty/u.test(e.message));
    await assert.rejects(withEnv({ STUB_CLI: "grok", STUB_DIR: r.ws, STUB_NO_USAGE: "1" }, () => runAgentWithCli(base)),
      (e: unknown) => e instanceof AgentStepFailed && e.completionReason === "worker_error" && /no usage record/u.test(e.message));
    assert.ok((await readFile(join(r.ws, "grok.log"), "utf8")).length > 0, "the raw transcript is still written on failure");
  } finally { await rm(r.root, { recursive: true, force: true }); }
});

test("a CLI that outlives its timeout is killed and reported as timeout", async () => {
  const r = await rig();
  try {
    const slow = join(r.root, "slow-cli");
    await writeFile(slow, "#!/bin/sh\nsleep 30\n", "utf8");
    await chmod(slow, 0o755);
    const started = Date.now();
    await assert.rejects(runAgentWithCli({ name: "codex", definition: { cli: "codex" }, task: "t", workspace: `${r.ws}: readwrite`, cwd: r.root, timeoutMs: 500, binaries: { codex: slow } }),
      (e: unknown) => e instanceof AgentStepFailed && e.completionReason === "timeout");
    assert.ok(Date.now() - started < 10_000, "did not wait for the 30s sleep");
    assert.match(await readFile(join(r.ws, "codex.log"), "utf8"), /--- completionReason: timeout/u);
  } finally { await rm(r.root, { recursive: true, force: true }); }
});

test("preflight is per (cli, model): auth failure is cli_unauthenticated; an unresolvable declared model is model_unavailable; a silent round-trip is not ready; a missing binary is cli_missing", async () => {
  const r = await rig();
  try {
    const targets = [{ cli: "claude" as const, model: "sonnet" }, { cli: "claude" as const, model: "opus" }, { cli: "codex" as const }, { cli: "grok" as const }];
    assert.deepEqual(await preflightHeadless(targets, r.binaries), []);
    // authenticated claude that cannot resolve ONE of its two declared models
    const opusGone = await withEnv({ STUB_MODEL_FAIL: "opus" }, () => preflightHeadless(targets, r.binaries));
    assert.deepEqual(opusGone.map((f) => [f.cli, f.model, f.kind]), [["claude", "opus", "model_unavailable"]], "only the opus pair fails; sonnet, codex, grok pass");
    const failed = await withEnv({ STUB_AUTH_FAIL: "1" }, () => preflightHeadless([{ cli: "claude" }], r.binaries));
    assert.equal(failed[0]?.kind, "cli_unauthenticated");
    const grokFailed = await withEnv({ STUB_AUTH_FAIL: "1" }, () => preflightHeadless([{ cli: "grok" }], r.binaries));
    assert.equal(grokFailed[0]?.kind, "model_unavailable", "grok has no auth probe; a round-trip the CLI refuses is model_unavailable");
    const silent = await withEnv({ STUB_PROBE_SILENT: "1" }, () => preflightHeadless([{ cli: "grok" }], r.binaries));
    assert.equal(silent[0]?.kind, "probe_failed", "exit 0 with an answer that is not OK is probe_failed, not a model problem");
    // Exactly OK, for every CLI shape: an answer that merely CONTAINS the
    // token must fail, or the probe is fail-open.
    for (const text of ["NOT OK", "OK.", "Okay", "OK OK"]) {
      const findings = await withEnv({ STUB_PROBE_TEXT: text }, () => preflightHeadless([{ cli: "claude" }, { cli: "codex" }, { cli: "grok" }], r.binaries));
      assert.deepEqual(findings.map((f) => [f.cli, f.kind]), [["claude", "probe_failed"], ["codex", "probe_failed"], ["grok", "probe_failed"]], `"${text}" must not pass any CLI's probe`);
    }
    // Only ASCII-space whitespace here: a raw newline embedded in the stub's
    // hand-built JSON text field would make the stub emit invalid JSON and
    // fail the probe for the wrong reason (a parse error, not the match).
    for (const text of ["OK", " OK ", "OK  "]) {
      assert.deepEqual(await withEnv({ STUB_PROBE_TEXT: text }, () => preflightHeadless([{ cli: "claude" }, { cli: "codex" }, { cli: "grok" }], r.binaries)), [], `"${JSON.stringify(text)}" passes`);
    }
    const missing = await preflightHeadless([{ cli: "codex" }], { codex: join(r.root, "does-not-exist") });
    assert.equal(missing[0]?.kind, "cli_missing");
  } finally { await rm(r.root, { recursive: true, force: true }); }
});

test("workspace dir must be absolute and normalized", () => {
  assert.throws(() => workspaceDir("relative/dir: readwrite"), /absolute and normalized/u);
  assert.throws(() => workspaceDir("/tmp//x: readwrite"), /absolute and normalized/u);
  assert.throws(() => workspaceDir("/tmp/./x: readwrite"), /absolute and normalized/u);
  assert.equal(workspaceDir("/tmp/x: readwrite"), "/tmp/x");
});

test("when one lane fails, the still-running sibling lanes are killed instead of spending until their timeout", { timeout: 15_000 }, async () => {
  const r = await rig();
  try {
    // claude: exits 3 at once. codex + grok: sleep 30s, well past what the
    // run below is allowed to take. Only the kill path makes this fast.
    // The slow stub records its own pid, then becomes `sleep` (exec keeps
    // the pid), so the test can ask the kernel whether it is still alive.
    const slow = join(r.root, "slow-cli");
    const pidFile = join(r.root, "pids");
    await writeFile(slow, `#!/bin/sh\necho $$ >> "${pidFile}"\nexec sleep 30\n`, "utf8");
    await chmod(slow, 0o755);
    const runDir = join(r.root, "run");
    await mkdir(runDir);
    for (const lane of ["claude", "codex", "grok"]) await mkdir(join(runDir, lane));
    const errors: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { errors.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      await assert.rejects(
        withEnv({ STUB_CLI: "claude", STUB_DIR: join(runDir, "claude"), STUB_EXIT: "3", STUB_WAIT_FILE: pidFile, STUB_WAIT_LINES: "2" }, () =>
          runResearch({ question: "q", runDir }, { cwd: r.root, timeoutMs: 60_000, runAgent: runAgentWithCli, binaries: { claude: r.stub, codex: slow, grok: slow } })),
        (e: unknown) => e instanceof AgentStepFailed && e.step === "claude" && e.completionReason === "worker_error",
      );
    } finally { process.stderr.write = write; }
    // Liveness, not timing: both sibling pids must be gone by the time the
    // run has rejected. process.kill(pid, 0) throws ESRCH for a dead process.
    const pids = (await readFile(pidFile, "utf8")).trim().split("\n").map(Number);
    assert.equal(pids.length, 2, "both slow lanes had started before claude failed");
    for (const pid of pids) {
      assert.throws(() => process.kill(pid, 0), (e: NodeJS.ErrnoException) => e.code === "ESRCH", `sibling ${pid} must be dead`);
    }
    assert.ok(errors.some((line) => /killed 2 still-running agent step/u.test(line)), `expected the kill line, got: ${errors.join("|")}`);
    // The discarded in-memory rejections leave a durable trace: each killed
    // sibling's transcript ends with its completionReason.
    for (const lane of ["codex", "grok"]) {
      const log = await readFile(join(runDir, lane, `${lane}.log`), "utf8");
      assert.match(log, /--- completionReason: aborted — killed because a sibling step failed/u, `${lane} log records why it died`);
    }
    assert.match(await readFile(join(runDir, "claude", "claude.log"), "utf8"), /--- completionReason: worker_error — .* exited 3/u);
  } finally { await rm(r.root, { recursive: true, force: true }); }
});

test("main(): every refusal is exit 2 and happens before anything is created; a fake run is exit 0", async () => {
  const r = await rig();
  try {
    const runsDir = join(r.root, "runs");
    const out: string[] = []; const err: string[] = [];
    const deps = { binaries: r.binaries, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l),
      runAgent: async (o: { name: string; workspace: string }) => {
        const dir = o.workspace.split(":")[0]!.trim();
        const file = o.name === "synthesizer" ? join(dir, "SYNTHESIS.md") : join(dir, "report.md");
        await mkdir(dir, { recursive: true }); await writeFile(file, "x", "utf8");
        return { summary: "ok", artifacts: [file], usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } };
      } };
    // bad argument → 2, nothing created
    assert.equal(await main(["--slug", "Bad Slug", "--question", "q", "--runs-dir", runsDir], deps), 2);
    assert.equal(await main(["--slug", "ok", "--question", "q", "--runs-dir", runsDir, "--timeout-minutes", "5.9"], deps), 2);
    assert.match(err.at(-1)!, /positive integer, got 5.9/u);
    assert.match(err.at(-1)!, /^REFUSED/u);
    await assert.rejects(readdir(runsDir), (e: NodeJS.ErrnoException) => e.code === "ENOENT");
    // unauthenticated CLI → 2, nothing created
    assert.equal(await withEnv({ STUB_AUTH_FAIL: "1" }, () => main(["--slug", "ok", "--question", "q", "--runs-dir", runsDir], deps)), 2);
    assert.match(err.at(-1)!, /cli_unauthenticated/u);
    await assert.rejects(readdir(runsDir), (e: NodeJS.ErrnoException) => e.code === "ENOENT");
    // runs/current is a real directory → 2, and the run dir is NOT created
    await mkdir(join(runsDir, "current"), { recursive: true });
    assert.equal(await main(["--slug", "ok", "--question", "q", "--runs-dir", runsDir], deps), 2);
    assert.match(err.at(-1)!, /not a symlink/u);
    assert.deepEqual(await readdir(runsDir), ["current"], "no half-materialized run dir");
    await rm(join(runsDir, "current"), { recursive: true });
    // happy path → 0, result on stdout, current symlink set
    assert.equal(await main(["--slug", "ok", "--question", "q", "--runs-dir", runsDir], deps), 0);
    const result = JSON.parse(out.at(-1)!);
    assert.equal(result.completionReason, "synthesized");
    assert.ok((await lstat(join(runsDir, "current"))).isSymbolicLink());
    // same slug again → 2 (non-empty run dir)
    assert.equal(await main(["--slug", "ok", "--question", "q", "--runs-dir", runsDir], deps), 2);
    assert.match(err.at(-1)!, /not empty/u);
    // race: an EMPTY run dir that appears between the readdir check and the
    // claim is refused by the atomic mkdir, not silently shared
    const raceDir = join(runsDir, `${new Date().toISOString().slice(0, 10)}-race`);
    await mkdir(raceDir);
    assert.equal(await main(["--slug", "race", "--question", "q", "--runs-dir", runsDir], deps), 2);
    assert.match(err.at(-1)!, /created concurrently/u);
  } finally { await rm(r.root, { recursive: true, force: true }); }
});

test("a lane that has not spawned yet when a sibling fails is aborted, never started", async () => {
  const r = await rig();
  try {
    const abort = new AbortController();
    abort.abort({ kind: "sibling_failed" });
    await assert.rejects(
      runAgentWithCli({ name: "grok", definition: { cli: "grok" }, task: "t", workspace: `${r.ws}: readwrite`, cwd: r.root, timeoutMs: 10_000, binaries: r.binaries, signal: abort.signal }),
      (e: unknown) => e instanceof AgentStepFailed && e.completionReason === "aborted",
    );
    assert.deepEqual((await readdir(r.ws)).filter((f) => f.endsWith(".trajectory.jsonl")), [], "no CLI ran, so no trajectory");
    assert.match(await readFile(join(r.ws, "grok.log"), "utf8"), /--- completionReason: aborted — killed because a sibling step failed; no CLI was run/u);
  } finally { await rm(r.root, { recursive: true, force: true }); }
});

test("a same-size rewrite of an existing file IS an artifact (content, not size or mtime, decides)", async () => {
  const r = await rig();
  try {
    // Pre-existing report.md: 8 bytes. The stub rewrites it with 8 different bytes.
    await writeFile(join(r.ws, "report.md"), "written\n", "utf8");
    const result = await withEnv({ STUB_CLI: "grok", STUB_DIR: r.ws, STUB_WRITE: "report.md", STUB_CONTENT: "rewrite" }, () =>
      runAgentWithCli({ name: "grok", definition: { cli: "grok" }, task: "t", workspace: `${r.ws}: readwrite`, cwd: r.root, timeoutMs: 10_000, binaries: r.binaries }));
    assert.equal((await readFile(join(r.ws, "report.md"), "utf8")).length, 8, "same size after rewrite");
    assert.deepEqual(result.artifacts, [join(r.ws, "report.md")]);
  } finally { await rm(r.root, { recursive: true, force: true }); }
});

test("SIGINT to the entry point stops every live agent (exit 130), instead of orphaning permission-bypassed CLIs", { timeout: 20_000 }, async () => {
  const r = await rig();
  try {
    // The real CLI entry resolves binaries on PATH: put the stub there under
    // all three names, and make every lane a long-running agent.
    const bin = join(r.root, "bin");
    await mkdir(bin);
    for (const name of ["claude", "codex", "grok"]) await writeFile(join(bin, name), STUB, "utf8").then(() => chmod(join(bin, name), 0o755));
    const runsDir = join(r.root, "runs");
    const entry = resolve(dirname(fileURLToPath(import.meta.url)), "..", "shims", "run.ts");
    const child = spawn(process.execPath, ["--experimental-strip-types", entry, "--slug", "sig", "--question", "q", "--runs-dir", runsDir], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, STUB_SLEEP: "1", STUB_PIDFILE: join(r.root, "pids") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    // Every lane's stub appends its pid to STUB_PIDFILE. Wait until three are live.
    const pidFile = join(r.root, "pids");
    const deadline = Date.now() + 10_000;
    let pids: number[] = [];
    while (Date.now() < deadline) {
      pids = (await readFile(pidFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(Number);
      if (pids.length === 3) break;
      await new Promise((d) => setTimeout(d, 100));
    }
    assert.equal(pids.length, 3, `three lanes live before the interrupt; stderr: ${stderr}`);
    child.kill("SIGINT");
    const code = await new Promise<number | null>((d) => child.once("close", d));
    assert.equal(code, 130, `exit 130 on SIGINT; stderr: ${stderr}`);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), (e: NodeJS.ErrnoException) => e.code === "ESRCH", `agent ${pid} must be dead`);
    assert.match(stderr, /SIGINT; stopped 3 agent step/u);
    assert.match(stderr, /INTERRUPTED by SIGINT/u);
    assert.ok(!/FAILED step/u.test(stderr), `an operator interrupt is not reported as a failed step; got: ${stderr}`);
    const runDir = join(runsDir, `${new Date().toISOString().slice(0, 10)}-sig`);
    for (const lane of ["claude", "codex", "grok"]) {
      assert.match(await readFile(join(runDir, lane, `${lane}.log`), "utf8"), /--- completionReason: aborted — stopped by operator SIGINT/u, `${lane} transcript records the operator interrupt, not a sibling failure`);
    }
  } finally { await rm(r.root, { recursive: true, force: true }); }
});

test("preflight: a probe terminated by a signal is probe_failed, not cli_unauthenticated", async () => {
  const r = await rig();
  try {
    const hang = join(r.root, "hang-cli");
    await writeFile(hang, "#!/bin/sh\nkill -KILL $$\n", "utf8");
    await chmod(hang, 0o755);
    const findings = await preflightHeadless([{ cli: "claude" }], { claude: hang });
    assert.equal(findings[0]?.kind, "probe_failed");
    assert.match(findings[0]?.message ?? "", /SIGKILL/u);
  } finally { await rm(r.root, { recursive: true, force: true }); }
});

test("a symlinked entrypoint still runs main (realpath comparison), exit 2 on a bad argument", async () => {
  const r = await rig();
  try {
    const entry = resolve(dirname(fileURLToPath(import.meta.url)), "..", "shims", "run.ts");
    const link = join(r.root, "research-link.ts");
    await symlink(entry, link);
    const child = spawn(process.execPath, ["--experimental-strip-types", link, "--bad"], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    const code = await new Promise<number | null>((d) => child.once("close", d));
    assert.equal(code, 2, `symlinked entry must refuse like the real one; stderr: ${stderr}`);
    assert.match(stderr, /REFUSED unknown argument --bad/u);
  } finally { await rm(r.root, { recursive: true, force: true }); }
});
