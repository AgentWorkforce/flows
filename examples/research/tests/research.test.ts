// Pins the flow body against a fake agent runtime: the fan-out is three
// concurrent agent steps, each lane's brief carries the question and the
// two-subagent protocol, synthesis runs only after every lane's gate passes,
// and a lane that writes no report fails the run closed before synthesis.
//
//   node --experimental-strip-types --test examples/research/tests/research.test.ts

import assert from "node:assert/strict";
import test from "node:test";
import researchFlow, { COMPLETION_REASONS, LANES, laneWorkspace, reportPath, synthesisPath, type Lane } from "../research.flow.ts";
import { AgentStepFailed } from "../shims/agent-cli.ts";
import { workspaceDir, type AgentRunOptions } from "../shims/agent-cli.ts";
import { headlessInvocation, isHeadlessCli, parseHeadless, HeadlessParseError } from "../shims/headless.ts";
import { GateFailed, LateGate, runResearch, createContext } from "../shims/run.ts";

const RUN_DIR = "/tmp/research-test-run";
const QUESTION = "What is the best-in-class agent memory design for a cloud agent?";

interface Deferred {
  resolve(): void;
  promise: Promise<void>;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { resolve, promise };
}

// 5s cap: under a serial-dispatch regression this test would deadlock, and
// node:test's default timeout is Infinity — a hang is not a failure report.
test("three lanes are dispatched concurrently, then one synthesis", { timeout: 5000 }, async () => {
  const started: string[] = [];
  const release = deferred();
  const calls: AgentRunOptions[] = [];

  const result = await runResearch(
    { question: QUESTION, runDir: RUN_DIR },
    {
      cwd: "/",
      timeoutMs: 1000,
      runAgent: async (options) => {
        calls.push(options);
        started.push(options.name);
        if (options.name !== "synthesizer") {
          // No lane may finish until all three have started: that is what
          // "fan-out" means, and a serial dispatch would deadlock here.
          if (started.filter((name) => name !== "synthesizer").length === LANES.length) release.resolve();
          await release.promise;
          return {
            summary: "RESEARCH_REPORT_WRITTEN",
            artifacts: [reportPath(RUN_DIR, options.name as Lane)],
            usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: "0.010000" },
          };
        }
        return { summary: "RESEARCH_SYNTHESIS_WRITTEN", artifacts: [synthesisPath(RUN_DIR)], usage: { inputTokens: 30, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } };
      },
    },
  );

  assert.deepEqual(started.slice(0, 3).sort(), [...LANES].sort());
  assert.equal(started[3], "synthesizer");
  assert.equal(result.completionReason, "synthesized");
  assert.equal(result.synthesis, `${RUN_DIR}/SYNTHESIS.md`);
  assert.deepEqual(result.reports, {
    claude: `${RUN_DIR}/claude/report.md`,
    codex: `${RUN_DIR}/codex/report.md`,
    grok: `${RUN_DIR}/grok/report.md`,
  });
  assert.deepEqual(Object.keys(result.usage).sort(), ["claude", "codex", "grok", "synthesizer"], "every step's budget line is on the result");
  assert.equal(result.usage.synthesizer?.outputTokens, 20);

  for (const lane of LANES) {
    const call = calls.find((c) => c.name === lane);
    assert.ok(call, `lane ${lane} was dispatched`);
    assert.match(call.task, /spawn exactly two subagents/u);
    assert.match(call.task, /Subagent A — Landscape/u);
    assert.match(call.task, /Subagent B — Applied/u);
    assert.ok(call.task.includes(QUESTION), "brief carries the question verbatim");
    assert.ok(call.task.includes(reportPath(RUN_DIR, lane)), "brief names the lane's report path");
    assert.equal(call.definition, researchFlow.header.agents[lane]);
    assert.equal(call.workspace, `${laneWorkspace(RUN_DIR, lane)}: readwrite`, "each lane owns its own workspace");
  }
  const synthesis = calls.find((c) => c.name === "synthesizer");
  assert.ok(synthesis);
  assert.equal(synthesis.workspace, `${RUN_DIR}: readwrite`, "the synthesizer sees the whole run dir");
  for (const lane of LANES) assert.ok(synthesis.task.includes(reportPath(RUN_DIR, lane)));
  assert.ok(synthesis.task.includes(synthesisPath(RUN_DIR)));
});

test("a lane that writes no report fails its gate and synthesis never runs", async () => {
  const dispatched: string[] = [];
  await assert.rejects(
    runResearch(
      { question: QUESTION, runDir: RUN_DIR },
      {
        cwd: "/",
        timeoutMs: 1000,
        runAgent: async (options) => {
          dispatched.push(options.name);
          const usage = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
          if (options.name === "codex") return { summary: "printed but did not write", artifacts: [], usage };
          if (options.name === "synthesizer") return { summary: "", artifacts: [synthesisPath(RUN_DIR)], usage };
          return { summary: "", artifacts: [reportPath(RUN_DIR, options.name as Lane)], usage };
        },
      },
    ),
    (error: unknown) => error instanceof GateFailed && error.step === "codex" && /must write its report/u.test(error.because ?? ""),
  );
  assert.ok(!dispatched.includes("synthesizer"), "synthesis must not run after a lane gate fails");
});

test("the header pins every agent's CLI and model exactly; a changed or dropped model fails here", () => {
  // Exact equality on the whole header: removing `model: "opus"` from the
  // synthesizer, or changing any lane, is a budget-relevant change that
  // must not pass silently.
  assert.deepEqual(researchFlow.header.agents, {
    claude: { cli: "claude", model: "sonnet" },
    codex: { cli: "codex", model: "gpt-5.6-sol" },
    grok: { cli: "grok", model: "grok-4.6" },
    synthesizer: { cli: "claude", model: "opus" },
  });
  for (const [name, agent] of Object.entries(researchFlow.header.agents)) {
    assert.ok(agent.model, `${name} declares a model; none is inherited from the host`);
  }
  assert.equal(researchFlow.header.budget, "$15/run");
});

test("every failure class reports a completionReason from COMPLETION_REASONS, and the set is exactly the documented one", () => {
  assert.deepEqual([...COMPLETION_REASONS], ["synthesized", "worker_error", "timeout", "aborted", "gate_failed", "protocol_error"]);
  for (const reason of ["worker_error", "timeout", "aborted"] as const) {
    assert.ok(COMPLETION_REASONS.includes(new AgentStepFailed("claude", reason, "x").completionReason));
  }
  assert.ok(COMPLETION_REASONS.includes(new GateFailed("claude", undefined).completionReason));
});

test("headless invocations use structured output and never put the task on argv", () => {
  for (const name of Object.keys(researchFlow.header.agents) as Array<keyof typeof researchFlow.header.agents>) {
    const definition = researchFlow.header.agents[name];
    assert.ok(isHeadlessCli(definition.cli), `${name} declares a CLI with a headless adapter`);
    if (!isHeadlessCli(definition.cli)) continue;
    const { argv, stdin } = headlessInvocation(definition.cli, { model: definition.model, promptFile: "/tmp/prompt.md", cwd: "/repo" });
    assert.equal(argv[0], definition.cli);
    // Exact structured-output flag per CLI (the task-on-argv property is
    // pinned in adapter.test.ts by capturing the stub's real argv).
    const expectedFlags: Record<string, string[]> = { claude: ["--output-format", "stream-json", "--verbose"], codex: ["--json"], grok: ["--output-format", "json"] };
    for (const flag of expectedFlags[definition.cli]!) assert.ok(argv.includes(flag), `${name} passes ${flag}`);
    if (stdin === "none") assert.ok(argv.includes("--prompt-file"), `${name} reads its prompt from a file`);
    assert.ok(argv.includes(definition.model!), `${name} passes its declared model ${definition.model} on the CLI's model flag`);
  }
  assert.equal(workspaceDir("/tmp/x: readwrite"), "/tmp/x");
  assert.equal(isHeadlessCli("terra"), false);
});

test("parseHeadless reads final text, usage, session and subagents from each CLI's verified shape", () => {
  const claude = parseHeadless("claude", [
    "Ignoring 1 permissions.allow entry (plain-text notice)",
    JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "OK" }] } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK", session_id: "s1",
      total_cost_usd: 0.0136945, subagent_stats: { count: 2 },
      usage: { input_tokens: 9, output_tokens: 42, cache_read_input_tokens: 17635, cache_creation_input_tokens: 5856 } }),
  ].join("\n"));
  assert.equal(claude.finalText, "OK");
  assert.deepEqual(claude.usage, { inputTokens: 9, outputTokens: 42, cacheReadInputTokens: 17635, cacheCreationInputTokens: 5856, costUsd: "0.013695" });
  assert.equal(claude.sessionId, "s1");
  assert.deepEqual(claude.subagents, { count: 2 });
  assert.equal(claude.events.length, 3, "plain-text notices are not events");

  const codex = parseHeadless("codex", [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "error", message: "skills shortened" } }),
    JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "OK" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 19693, cached_input_tokens: 11008, cache_write_input_tokens: 4, output_tokens: 5 } }),
  ].join("\n"));
  assert.equal(codex.finalText, "OK");
  assert.deepEqual(codex.usage, { inputTokens: 19693, outputTokens: 5, cacheReadInputTokens: 11008, cacheCreationInputTokens: 4 });
  assert.equal(codex.sessionId, "t1");

  // Multi-turn: usage is the SUM over every turn, text is the last message.
  const multi = parseHeadless("codex", [
    JSON.stringify({ type: "thread.started", thread_id: "t2" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 1 } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "second" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 200, cached_input_tokens: 20, output_tokens: 2 } }),
  ].join("\n"));
  assert.equal(multi.finalText, "second");
  assert.deepEqual(multi.usage, { inputTokens: 300, outputTokens: 3, cacheReadInputTokens: 30, cacheCreationInputTokens: 0 });

  const grok = parseHeadless("grok", "notice line\n" + JSON.stringify({ text: "OK", sessionId: "g1", total_cost_usd: 0.00330718,
    usage: { input_tokens: 6742, cache_read_input_tokens: 11520, output_tokens: 35 } }));
  assert.equal(grok.finalText, "OK");
  assert.deepEqual(grok.usage, { inputTokens: 6742, outputTokens: 35, cacheReadInputTokens: 11520, cacheCreationInputTokens: 0, costUsd: "0.003307" });
  assert.equal(grok.sessionId, "g1");
});

test("a CLI that exits without a readable, non-empty final message and a usage record is unreadable, not an empty success", () => {
  const usage = { input_tokens: 1, output_tokens: 1 };
  // missing envelope
  assert.throws(() => parseHeadless("claude", JSON.stringify({ type: "system", subtype: "init" })), HeadlessParseError);
  assert.throws(() => parseHeadless("claude", JSON.stringify({ type: "result", is_error: true, result: "boom", usage })), /is_error/u);
  assert.throws(() => parseHeadless("codex", JSON.stringify({ type: "turn.completed", usage })), HeadlessParseError);
  assert.throws(() => parseHeadless("grok", "no json here"), HeadlessParseError);
  // EMPTY final message — the case the history lens found passing before
  assert.throws(() => parseHeadless("claude", JSON.stringify({ type: "result", is_error: false, result: "", usage })), /missing or empty/u);
  assert.throws(() => parseHeadless("codex", [JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "" } }), JSON.stringify({ type: "turn.completed", usage })].join("\n")), /missing or empty/u);
  assert.throws(() => parseHeadless("grok", JSON.stringify({ text: "   ", usage })), /missing or empty/u);
  // no usage record
  assert.throws(() => parseHeadless("claude", JSON.stringify({ type: "result", is_error: false, result: "OK" })), /no usage record/u);
  assert.throws(() => parseHeadless("codex", JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OK" } })), /no usage record/u);
  assert.throws(() => parseHeadless("grok", JSON.stringify({ text: "OK" })), /no usage record/u);
});

test("usage counters must be finite numbers: missing or string-valued input/output tokens are a parse error, absent cache counters are 0", () => {
  const ok = parseHeadless("grok", JSON.stringify({ text: "OK", usage: { input_tokens: 1, output_tokens: 2 } }));
  assert.deepEqual(ok.usage, { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: undefined });
  assert.throws(() => parseHeadless("grok", JSON.stringify({ text: "OK", usage: { input_tokens: "1", output_tokens: 2 } })), /usage.input_tokens is not a finite number/u);
  assert.throws(() => parseHeadless("grok", JSON.stringify({ text: "OK", usage: { prompt_tokens: 1, output_tokens: 2 } })), /usage.input_tokens/u);
  assert.throws(() => parseHeadless("grok", JSON.stringify({ text: "OK", usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: "x" } })), /cache_read_input_tokens/u);
  assert.throws(() => parseHeadless("claude", JSON.stringify({ type: "result", is_error: false, result: "OK", usage: { input_tokens: 1 } })), /usage.output_tokens/u);
  assert.throws(() => parseHeadless("codex", [JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OK" } }), JSON.stringify({ type: "turn.completed", usage: { input_tokens: Number.NaN, output_tokens: 1 } })].join("\n")), /usage.input_tokens/u);
});

test("a gate registered after the step was awaited throws instead of silently never running", async () => {
  const ctx = createContext(researchFlow, {
    cwd: "/", timeoutMs: 1000,
    runAgent: async () => ({ summary: "x", artifacts: [], usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }),
  });
  const s = ctx.agent("claude", { task: "t", workspace: "/tmp/x: readwrite" });
  await s;
  assert.throws(() => s.gate(() => false, "late"), LateGate);
});

test("a lane that reports no usage fails its budget gate", async () => {
  await assert.rejects(
    runResearch(
      { question: QUESTION, runDir: RUN_DIR },
      {
        cwd: "/", timeoutMs: 1000,
        runAgent: async (options) => ({ summary: "ok", artifacts: [options.name === "synthesizer" ? synthesisPath(RUN_DIR) : reportPath(RUN_DIR, options.name as Lane)] }),
      },
    ),
    (error: unknown) => error instanceof GateFailed && /token usage/u.test(error.because ?? ""),
  );
});
