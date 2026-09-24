import { realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * Where an agent step runs.
 *
 * A declared `cwd` is a path relative to the **run root** — the working
 * directory of the process running the agent worker, which is the directory
 * `flows run` was invoked from and, on the Cloud path, the uploaded tree
 * (docs/CLOUD.md, "Code sync"). Absent, a step runs in the run root itself.
 *
 * Two checks, in two places, because they are two different facts:
 *
 * - The **declaration** is lexical and filesystem-free, so `flows check`, the
 *   kernel's `validate()` and this worker all answer identically for the same
 *   spec. `testdata/agent-cwd-cases.json` is the shared corpus both dialects
 *   are tested against.
 * - The **target** is resolved here, in the worker that spawns the CLI — the
 *   one process provably sharing the agent's filesystem. A directory that
 *   exists, and whose symlink-free path is inside the symlink-free run root.
 *   Repeated at execution even when a preflight already passed, because the
 *   filesystem moves underneath a spec.
 *
 * This contains a declaration; it does not sandbox an agent. Nothing stops a
 * CLI from writing outside the directory it was started in. Per-step scoping
 * is `permissions`, which is recorded and not enforced (gate 8 / #442).
 */
export class AgentCwdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentCwdError';
  }
}

/**
 * Why a declared `cwd` is not a run-root-relative path, or `undefined` when it
 * is one. Pure and lexical: the exact rule
 * `relayflowd_core::spec::is_run_root_relative_path` applies at the kernel
 * boundary, so a declaration that passes `flows check` is not refused later by
 * the daemon for its shape.
 */
export function agentCwdDeclarationError(cwd: unknown): string | undefined {
  const expected = 'expected a run-root-relative path';
  if (typeof cwd !== 'string') return `${expected} (got ${cwd === null ? 'null' : typeof cwd})`;
  if (cwd === '') return `${expected}, not an empty string`;
  if (PADDING.test(cwd)) return `${expected} without surrounding whitespace`;
  if (cwd.includes('\0')) return `${expected} without NUL`;
  if (cwd.startsWith('/')) return `${expected}, not an absolute path`;
  if (cwd.includes('://')) return `${expected}, not a URI-like mount identity`;
  if (cwd.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    return `${expected} without empty, "." or ".." components`;
  }
  return undefined;
}

/**
 * Whitespace at either end, spelled so both dialects refuse the same set.
 * JavaScript's `\s` is Unicode `White_Space` without U+0085 and with U+FEFF;
 * Rust's `char::is_whitespace` is `White_Space` exactly. Naming U+0085 here
 * and U+FEFF there makes both `White_Space ∪ {U+FEFF}`. Left to `trim()`
 * alone, a path padded with either character would pass `flows check` and be
 * refused by the kernel — the accept-then-refuse split this contract closes.
 */
const PADDING = /^[\s\u0085]|[\s\u0085]$/u;

/**
 * The refusal for a `cwd` declared on a step dispatched over the relay
 * transport, or `undefined` when there is nothing to refuse.
 *
 * The relay agent runs on another host. This process can neither resolve that
 * host's filesystem nor establish that the directory is inside that run's
 * tree, and forwarding the string as `worker_cwd` would let a declaration this
 * contract promises to contain go unchecked. Fail closed instead of pretending.
 */
export function agentCwdTransportError(cwd: unknown, transport: unknown): string | undefined {
  if (cwd === undefined || transport !== 'relay') return undefined;
  return 'cwd is not supported with transport "relay": the agent runs on another host, '
    + 'where this worker cannot resolve the directory or hold it inside the run root';
}

/**
 * The directory to spawn the CLI in: `root` when nothing is declared, else the
 * symlink-free directory `cwd` names beneath `root`.
 *
 * @throws AgentCwdError naming the declaration and what is wrong with it.
 */
export function resolveAgentCwd(root: string, cwd: unknown, transport?: unknown): string | undefined {
  if (cwd === undefined) return undefined;
  const refusal = (detail: string): AgentCwdError =>
    new AgentCwdError(`cwd ${JSON.stringify(cwd)}: ${detail}`);
  const declaration = agentCwdDeclarationError(cwd);
  if (declaration !== undefined) throw refusal(declaration);
  const unsupported = agentCwdTransportError(cwd, transport);
  if (unsupported !== undefined) throw new AgentCwdError(unsupported);

  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    throw refusal(`the run root ${JSON.stringify(root)} cannot be resolved on this host`);
  }
  let target: string;
  try {
    target = realpathSync(resolve(realRoot, cwd as string));
  } catch {
    throw refusal(`no such directory under the run root ${JSON.stringify(realRoot)}`);
  }
  // Component-aware, on the symlink-free forms of both: `checkout-b-old` is
  // not inside `checkout-b`, and a symlink pointing out of the tree is not
  // inside it either however it is spelled.
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (target !== realRoot && !target.startsWith(prefix)) {
    throw refusal(`resolves to ${JSON.stringify(target)}, outside the run root ${JSON.stringify(realRoot)}`);
  }
  if (!statSync(target).isDirectory()) throw refusal(`${JSON.stringify(target)} is not a directory`);
  return target;
}

/** Either the directory an agent step runs in, or why the step is refused. */
export type AgentCwdOutcome = { directory: string | undefined } | { refusal: string };

/**
 * The dispatch-time form: resolve a dispatched agent step's `cwd` against the
 * run root, or report the refusal for the worker to complete the step with.
 * Reporting rather than throwing keeps the refusal on the step's completion —
 * `worker_error`, with the reason journaled — instead of on the worker.
 */
export function agentStepCwd(
  spec: { cwd?: unknown; transport?: unknown },
  stepId: string,
  root: string = process.cwd(),
): AgentCwdOutcome {
  try {
    return { directory: resolveAgentCwd(root, spec.cwd, spec.transport) };
  } catch (error) {
    if (!(error instanceof AgentCwdError)) throw error;
    return { refusal: `agent step "${stepId}": ${error.message}` };
  }
}
