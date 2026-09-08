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

import { spawn } from "node:child_process";

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

/** Required counter: must be a finite number. A missing, renamed, or
 *  string-valued input/output count is a parse error, never a silent zero —
 *  a zero-token budget line is worse than no budget line. */
function requireNum(cli: HeadlessCli, usage: Record<string, unknown>, key: string): number {
  const value = usage[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HeadlessParseError(cli, `usage.${key} is not a finite number`);
  }
  return value;
}

/** Optional cache counter: absent means 0; present but invalid is an error. */
function optNum(cli: HeadlessCli, usage: Record<string, unknown>, key: string): number {
  const value = usage[key];
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HeadlessParseError(cli, `usage.${key} is not a finite number`);
  }
  return value;
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
      inputTokens: requireNum("claude", usage, "input_tokens"),
      outputTokens: requireNum("claude", usage, "output_tokens"),
      cacheReadInputTokens: optNum("claude", usage, "cache_read_input_tokens"),
      cacheCreationInputTokens: optNum("claude", usage, "cache_creation_input_tokens"),
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
      inputTokens: usages.reduce((n, u) => n + requireNum("codex", u, "input_tokens"), 0),
      outputTokens: usages.reduce((n, u) => n + requireNum("codex", u, "output_tokens"), 0),
      cacheReadInputTokens: usages.reduce((n, u) => n + optNum("codex", u, "cached_input_tokens"), 0),
      cacheCreationInputTokens: usages.reduce((n, u) => n + optNum("codex", u, "cache_write_input_tokens"), 0),
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
      inputTokens: requireNum("grok", usage, "input_tokens"),
      outputTokens: requireNum("grok", usage, "output_tokens"),
      cacheReadInputTokens: optNum("grok", usage, "cache_read_input_tokens"),
      cacheCreationInputTokens: optNum("grok", usage, "cache_creation_input_tokens"),
      costUsd: money(parsed["total_cost_usd"]),
    },
    sessionId: typeof parsed["sessionId"] === "string" ? parsed["sessionId"] : undefined,
    events: [parsed],
  };
}

// --- Preflight ---------------------------------------------------------------
//
// Discovering a missing, unauthenticated, or model-less CLI after the run has
// started is a failure class this repo removed once already (ops/DRIVE-LOG.md
// WP-4; testdata/preflight/analyze-story-claude-cli, which probes Claude WITH
// its declared model) and SURFACE.md covenant 2 forbids. So preflight is per
// declared (cli, model) pair, not per CLI, and every probe is a real
// readiness signal, verified 2026-09-03:
//   1. a cheap auth probe where the CLI has one: `claude auth status` (exit 0 +
//      {"loggedIn": true}), `codex login status` (exit 0). Grok has none.
//   2. a live one-line round-trip using the declared model flag —
//      `claude -p --output-format json [--model M] <prompt>`,
//      `codex exec --json [-m M] <prompt>`, `grok -p <prompt> --output-format json [-m M]` —
//      which must answer OK. A CLI that is authenticated but cannot resolve
//      the model (an alias the host does not know) fails HERE, at minute
//      zero, as model_unavailable. Costs a few tokens per pair.
//
// DIVERGENCE from SURFACE.md §2 law 6, which requires a preflightable CLI to
// answer `<cli> auth status`: only Claude does. Gate 1's `flows check` will
// enforce that contract; thin wrappers per CLI close it. The probes here are
// equivalent in strength, not in shape.

export interface PreflightTarget {
  cli: HeadlessCli;
  model?: string;
}

export interface PreflightFinding {
  cli: HeadlessCli;
  model?: string;
  kind: "cli_missing" | "cli_unauthenticated" | "model_unavailable" | "probe_failed";
  message: string;
}

export const PROBE_PROMPT = "Reply with exactly OK and nothing else.";

function authProbeArgs(cli: HeadlessCli): string[] | undefined {
  switch (cli) {
    case "claude": return ["auth", "status"];
    case "codex": return ["login", "status"];
    case "grok": return undefined;
  }
}

function roundTripArgs(cli: HeadlessCli, model: string | undefined): string[] {
  switch (cli) {
    case "claude": return ["-p", "--output-format", "json", ...(model ? ["--model", model] : []), PROBE_PROMPT];
    case "codex": return ["exec", "--json", "--skip-git-repo-check", ...(model ? ["-m", model] : []), PROBE_PROMPT];
    case "grok": return ["-p", PROBE_PROMPT, "--output-format", "json", ...(model ? ["-m", model] : [])];
  }
}

/** The probe asked for exactly OK; accept exactly OK. Whitespace is
 *  trimmed and nothing else is: "NOT OK", "OK." and "Okay" all fail, so a
 *  model that did not follow the one-line instruction cannot pass a gate
 *  whose only purpose is to prove it answered as asked. */
export function isExactOk(text: string): boolean {
  return text.trim() === "OK";
}

/** Did the round-trip answer exactly OK? Each CLI's structured shape, verified live. */
function roundTripAnswered(cli: HeadlessCli, stdout: string): boolean {
  try {
    if (cli === "codex") {
      const texts = jsonLines(stdout)
        .map((e) => (e["item"] as Record<string, unknown> | undefined))
        .filter((item): item is Record<string, unknown> => item?.["type"] === "agent_message")
        .map((item) => String(item["text"] ?? ""));
      return isExactOk(texts[texts.length - 1] ?? "");
    }
    const obj = JSON.parse(stdout.slice(stdout.indexOf("{"))) as Record<string, unknown>;
    if (cli === "claude") return obj["is_error"] !== true && isExactOk(String(obj["result"] ?? ""));
    return isExactOk(String(obj["text"] ?? ""));
  } catch {
    return false;
  }
}

interface ProbeResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
}

/** Async so the event loop keeps turning during the round-trips: the
 *  SIGINT/SIGTERM handlers must be able to run while preflight is probing.
 *  stdin is IGNORED, not piped: Codex reads a piped stdin as part of the
 *  prompt and waits for EOF, so an open pipe makes it answer nothing. */
function probe(bin: string, args: string[], timeout: number): Promise<ProbeResult> {
  return new Promise((resolveProbe) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));
    child.once("error", (error) => {
      clearTimeout(timer);
      resolveProbe({ status: null, signal: null, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), error: error as NodeJS.ErrnoException });
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolveProbe({ status, signal, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

export async function preflightHeadless(
  targets: readonly PreflightTarget[],
  binaries?: HeadlessBinaries,
  onProbe?: (label: string, timeoutMs: number) => void,
): Promise<PreflightFinding[]> {
  const findings: PreflightFinding[] = [];
  const seen = new Set<string>();
  const authChecked = new Set<HeadlessCli>();
  for (const { cli, model } of targets) {
    const key = `${cli}\u0000${model ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bin = binaryFor(cli, binaries);
    const classify = (label: string, result: ProbeResult): PreflightFinding | undefined => {
      if (result.error) {
        return { cli, model, kind: result.error.code === "ENOENT" ? "cli_missing" : "probe_failed", message: `${label}: ${result.error.message}` };
      }
      if (result.signal) {
        // Terminated by a signal (or the probe timeout): says nothing about
        // authentication or the model. SURFACE.md classifies it probe_failed.
        return { cli, model, kind: "probe_failed", message: `${label} was terminated by ${result.signal}` };
      }
      return undefined;
    };

    // 1. auth probe, once per CLI
    const auth = authProbeArgs(cli);
    if (auth && !authChecked.has(cli)) {
      authChecked.add(cli);
      const label = `${cli} ${auth.join(" ")}`;
      onProbe?.(label, 10_000);
      const result = await probe(bin, auth, 10_000);
      const early = classify(label, result);
      if (early) { findings.push(early); continue; }
      if (result.status !== 0 || (cli === "claude" && !/"loggedIn":\s*true/u.test(result.stdout))) {
        findings.push({ cli, model, kind: "cli_unauthenticated", message: `${label} exited ${result.status}: ${(result.stderr || result.stdout || "").trim().slice(0, 200)}` });
        continue;
      }
    }

    // 2. live round-trip with the declared model
    const args = roundTripArgs(cli, model);
    const label = `${cli} round-trip${model ? ` with model ${model}` : ""}`;
    onProbe?.(label, 90_000);
    const result = await probe(bin, args, 90_000);
    const early = classify(label, result);
    if (early) { findings.push(early); continue; }
    if (result.status !== 0) {
      // The CLI refused the request: for an authenticated CLI that is the
      // model (an alias this host cannot resolve, or one it cannot use).
      findings.push({ cli, model, kind: "model_unavailable", message: `${label} exited ${result.status}: ${(result.stderr || result.stdout || "").trim().slice(0, 200)}` });
      continue;
    }
    if (!roundTripAnswered(cli, result.stdout)) {
      // It ran and answered, just not exactly "OK": the model exists; the
      // probe did not get the reply it asked for. Say that, not "model
      // unavailable".
      findings.push({ cli, model, kind: "probe_failed", message: `${label} answered but not exactly OK: ${(result.stdout || "").trim().slice(0, 200)}` });
    }
  }
  return findings;
}
