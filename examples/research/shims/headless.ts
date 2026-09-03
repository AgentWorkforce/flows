// REPLACE-WHEN: the SDK's AgentWorker owns a headless adapter per CLI.
//
// A relayflow must never hand a raw `-p` to a CLI and read its last line.
// Each agent CLI has a non-interactive mode that emits structured events
// with the final message, token usage, cost, session id and, for Claude,
// subagent statistics. That structure IS the step's trajectory (RFC-0001:
// an agent step's output is artifact + diff + trajectory) and its budget
// line (decision 10: every token has one owner). This module is the
// contract: how to invoke each CLI headless, and how to read what it says.
//
// Verified shapes, 2026-09-02:
//   claude -p --output-format stream-json --verbose   JSONL; final {"type":"result",
//       "result": <text>, "is_error", "usage": {input_tokens, output_tokens,
//       cache_read_input_tokens, cache_creation_input_tokens}, "total_cost_usd",
//       "session_id", "subagent_stats", "modelUsage"}
//   codex exec --json -                                JSONL; {"type":"thread.started","thread_id"},
//       {"type":"item.completed","item":{"type":"agent_message","text"}},
//       {"type":"turn.completed","usage":{input_tokens, cached_input_tokens, output_tokens}}
//   grok --prompt-file F --output-format json          one JSON object: {text, sessionId,
//       usage:{input_tokens, output_tokens, cache_read_input_tokens}, total_cost_usd, thought}

import { spawnSync } from "node:child_process";

export type HeadlessCli = "claude" | "codex" | "grok";

/** Binary to execute per CLI. Defaults to the bare name resolved on PATH;
 *  tests and operators may point a CLI at another executable (a stub, a
 *  pinned install) without changing the invocation contract. */
export type HeadlessBinaries = Partial<Record<HeadlessCli, string>>;

export function binaryFor(cli: HeadlessCli, binaries?: HeadlessBinaries): string {
  return binaries?.[cli] ?? cli;
}

export interface HeadlessUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  /** Tokens written to the provider's prompt cache. Claude and Grok report
   *  it under cache_creation_input_tokens, Codex under cache_write_input_tokens. */
  cacheCreationInputTokens: number;
  /** Decimal string at the boundary (kernel DESIGN.md §1: no floats for money). Absent when the CLI does not report cost. */
  costUsd?: string;
}

export interface HeadlessResult {
  /** Non-empty; an empty final message is a parse error. */
  finalText: string;
  /** Always present; a missing usage record is a parse error. */
  usage: HeadlessUsage;
  sessionId?: string;
  /** CLI-reported subagent statistics, when the CLI reports them (Claude does). */
  subagents?: unknown;
  /** Every structured event the CLI emitted, in order — the trajectory. */
  events: unknown[];
}

export interface HeadlessInvocation {
  argv: string[];
  /** Where the task travels. Never argv: a long brief must not hit ARG_MAX. */
  stdin: "prompt" | "none";
}

export function isHeadlessCli(cli: string): cli is HeadlessCli {
  return cli === "claude" || cli === "codex" || cli === "grok";
}

/**
 * PERMISSIONS ARE BYPASSED. Every invocation below disables the CLI's own
 * approval prompts (`--dangerously-skip-permissions`,
 * `--dangerously-bypass-approvals-and-sandbox`, `--always-approve`) and runs
 * from the repo root. The flow's `workspace:` declaration is NOT enforced by
 * this shim: it only decides where the prompt, log and trajectory land and
 * which top-level files count as artifacts. Containment of what a lane may
 * write is RFC-0001 Appendix A rule 1 / gate 8 work that the kernel owns;
 * until then an operator runs three unsandboxed agents by invoking this.
 */
export function headlessInvocation(
  cli: HeadlessCli,
  options: { model?: string; promptFile: string; cwd: string; binaries?: HeadlessBinaries },
): HeadlessInvocation {
  const { model, promptFile, cwd } = options;
  const bin = binaryFor(cli, options.binaries);
  switch (cli) {
    case "claude":
      return {
        argv: [
          bin, "-p",
          "--output-format", "stream-json", "--verbose",
          "--dangerously-skip-permissions",
          ...(model ? ["--model", model] : []),
        ],
        stdin: "prompt",
      };
    case "codex":
      return {
        argv: [
          bin, "exec", "--json",
          "--dangerously-bypass-approvals-and-sandbox",
          "--skip-git-repo-check",
          "-C", cwd,
          ...(model ? ["-m", model] : []),
          "-",
        ],
        stdin: "prompt",
      };
    case "grok":
      return {
        argv: [
          bin,
          "--prompt-file", promptFile,
          "--output-format", "json",
          "--always-approve",
          "--permission-mode", "bypassPermissions",
          "--cwd", cwd,
          ...(model ? ["-m", model] : []),
        ],
        stdin: "none",
      };
  }
}

export class HeadlessParseError extends Error {
  readonly cli: HeadlessCli;
  constructor(cli: HeadlessCli, detail: string) {
    super(`${cli}: headless output could not be read: ${detail}`);
    this.cli = cli;
  }
}

/** Parse a CLI's headless stdout. Throws HeadlessParseError when the output
 *  carries no final message — a CLI that exited 0 without saying what it did
 *  is a worker_error, not a success with an empty summary. */
export function parseHeadless(cli: HeadlessCli, stdout: string): HeadlessResult {
  switch (cli) {
    case "claude": return parseClaude(stdout);
    case "codex": return parseCodex(stdout);
    case "grok": return parseGrok(stdout);
  }
}

function jsonLines(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue; // CLIs interleave plain-text warnings
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null) events.push(parsed as Record<string, unknown>);
    } catch {
      // A torn line is not an event; the final-message check below decides
      // whether the stream as a whole is usable.
    }
  }
  return events;
}

/** A final message must be present AND non-empty. An agent that exited 0
 *  having said nothing did not report what it did; that is worker_error. */
function requireText(cli: HeadlessCli, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HeadlessParseError(cli, "final message is missing or empty");
  }
  return value;
}

/** Usage is the step's budget line (RFC-0001 decision 10). A CLI that did
 *  not report it leaves the step's spend unowned; refuse rather than guess. */
function requireUsage(cli: HeadlessCli, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new HeadlessParseError(cli, "no usage record in the output");
  }
  return value as Record<string, unknown>;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function money(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(6) : undefined;
}

function parseClaude(stdout: string): HeadlessResult {
  const events = jsonLines(stdout);
  const result = events.find((e) => e["type"] === "result");
  if (!result) throw new HeadlessParseError("claude", "no {\"type\":\"result\"} event");
  if (result["is_error"] === true) throw new HeadlessParseError("claude", `result.is_error: ${String(result["result"])}`);
  const finalText = requireText("claude", result["result"]);
  const usage = requireUsage("claude", result["usage"]);
  return {
    finalText,
    usage: {
      inputTokens: num(usage["input_tokens"]),
      outputTokens: num(usage["output_tokens"]),
      cacheReadInputTokens: num(usage["cache_read_input_tokens"]),
      cacheCreationInputTokens: num(usage["cache_creation_input_tokens"]),
      costUsd: money(result["total_cost_usd"]),
    },
    sessionId: typeof result["session_id"] === "string" ? result["session_id"] : undefined,
    subagents: result["subagent_stats"],
    events,
  };
}

function parseCodex(stdout: string): HeadlessResult {
  const events = jsonLines(stdout);
  const messages = events
    .filter((e) => e["type"] === "item.completed")
    .map((e) => e["item"] as Record<string, unknown> | undefined)
    .filter((item): item is Record<string, unknown> => item?.["type"] === "agent_message");
  const last = messages[messages.length - 1];
  if (!last) throw new HeadlessParseError("codex", "no item.completed agent_message event");
  // Usage is SUMMED over every turn.completed: a multi-turn exec run reports
  // one usage record per turn, and the budget line must own all of them.
  const turns = events.filter((e) => e["type"] === "turn.completed");
  const finalText = requireText("codex", last["text"]);
  if (turns.length === 0) throw new HeadlessParseError("codex", "no usage record in the output");
  const usages = turns.map((t) => requireUsage("codex", t["usage"]));
  const thread = events.find((e) => e["type"] === "thread.started");
  return {
    finalText,
    usage: {
      inputTokens: usages.reduce((n, u) => n + num(u["input_tokens"]), 0),
      outputTokens: usages.reduce((n, u) => n + num(u["output_tokens"]), 0),
      cacheReadInputTokens: usages.reduce((n, u) => n + num(u["cached_input_tokens"]), 0),
      cacheCreationInputTokens: usages.reduce((n, u) => n + num(u["cache_write_input_tokens"]), 0),
    },
    sessionId: typeof thread?.["thread_id"] === "string" ? thread["thread_id"] : undefined,
    events,
  };
}

function parseGrok(stdout: string): HeadlessResult {
  // One JSON object, possibly preceded by plain-text notices.
  const start = stdout.indexOf("{");
  if (start < 0) throw new HeadlessParseError("grok", "no JSON object on stdout");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout.slice(start)) as Record<string, unknown>;
  } catch (error) {
    throw new HeadlessParseError("grok", String(error));
  }
  const finalText = requireText("grok", parsed["text"]);
  const usage = requireUsage("grok", parsed["usage"]);
  return {
    finalText,
    usage: {
      inputTokens: num(usage["input_tokens"]),
      outputTokens: num(usage["output_tokens"]),
      cacheReadInputTokens: num(usage["cache_read_input_tokens"]),
      cacheCreationInputTokens: num(usage["cache_creation_input_tokens"]),
      costUsd: money(parsed["total_cost_usd"]),
    },
    sessionId: typeof parsed["sessionId"] === "string" ? parsed["sessionId"] : undefined,
    events: [parsed],
  };
}

// --- Preflight ---------------------------------------------------------------
//
// Discovering a missing or unauthenticated CLI after the run has started is a
// failure class this repo removed once already (ops/DRIVE-LOG.md, WP-4) and
// SURFACE.md's preflight covenant forbids. Probe before any run directory is
// created.
//
// DIVERGENCE from SURFACE.md §2 law 6, which requires a preflightable CLI to
// answer `<cli> auth status`: only Claude does. Codex answers `login status`
// and Grok has no auth probe at all. Gate 1's `flows check` will enforce the
// contract; until the vendor CLIs (or thin wrappers) answer `auth status`,
// two of the three lanes here would fail that gate. The probes below are what
// each CLI actually offers, verified 2026-09-02:
//   claude  `claude auth status`  → exit 0 + {"loggedIn": true}
//   codex   `codex login status`  → exit 0 + "Logged in ..."
//   grok    has no auth probe; only binary presence + `--version` is checked,
//           so an expired Grok login still surfaces at dispatch. Documented.

export interface PreflightFinding {
  cli: HeadlessCli;
  kind: "cli_missing" | "cli_unauthenticated" | "probe_failed";
  message: string;
}

export function preflightHeadless(clis: readonly HeadlessCli[], binaries?: HeadlessBinaries): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  for (const cli of new Set(clis)) {
    const probe = cli === "claude" ? ["auth", "status"] : cli === "codex" ? ["login", "status"] : ["--version"];
    const result = spawnSync(binaryFor(cli, binaries), probe, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      findings.push({ cli, kind: code === "ENOENT" ? "cli_missing" : "probe_failed", message: `${cli} ${probe.join(" ")}: ${result.error.message}` });
      continue;
    }
    if (result.signal) {
      // Terminated by a signal (or the 10s probe timeout): that says nothing
      // about authentication. SURFACE.md classifies it as probe_failed.
      findings.push({ cli, kind: "probe_failed", message: `${cli} ${probe.join(" ")} was terminated by ${result.signal}` });
      continue;
    }
    if (result.status !== 0) {
      findings.push({ cli, kind: cli === "grok" ? "probe_failed" : "cli_unauthenticated", message: `${cli} ${probe.join(" ")} exited ${result.status}: ${(result.stderr || result.stdout || "").trim().slice(0, 200)}` });
      continue;
    }
    if (cli === "claude" && !/"loggedIn":\s*true/u.test(result.stdout)) {
      findings.push({ cli, kind: "cli_unauthenticated", message: `claude auth status did not report loggedIn: true` });
    }
  }
  return findings;
}
