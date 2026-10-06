import { spawnSync } from 'node:child_process';
import { canonicalize } from './canonical.js';
import { CompileError, toKernelSpec } from './compile.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { RelayflowdNotFoundError, resolveRelayflowdBinary } from './relayflowd-path.js';
import type { FlowSpec } from './spec.js';
import type { CheckReport } from './cli/check.js';

export type DaemonValidationMode = 'auto' | 'required' | 'off';
type Unavailable = 'disabled' | 'not_reached' | 'authored_body' | 'relayflowd_not_found'
  | 'relayflowd_bin_invalid' | 'no_verdict' | 'spawn_failed' | 'timed_out' | 'protocol_mismatch';
export interface DaemonValidation {
  mode: 'daemon' | 'local';
  binary?: string;
  protocol?: number;
  specVersion?: string;
  reason?: Unavailable;
}
export interface DaemonValidationDeps {
  resolveBinary(): string;
  run(binary: string, input: string): {
    status: number | null; stdout: string; stderr: string; error?: Error;
  };
}
type Result = { validation: DaemonValidation; diagnostics: CheckReport['diagnostics'] };
// Cache discovery, never verdicts. Changed resolution inputs get a fresh lookup.
const binaries = new Map<string, string | Error>();
const defaults: DaemonValidationDeps = {
  resolveBinary() {
    const key = JSON.stringify([process.env['RELAYFLOWD_BIN'], process.env['PATH'], process.cwd(), process.argv[1]]);
    let found = binaries.get(key);
    if (found === undefined) {
      try { found = resolveRelayflowdBinary(); }
      catch (error) { found = error instanceof Error ? error : new Error(String(error)); }
      binaries.set(key, found);
    }
    if (found instanceof Error) throw found;
    return found;
  },
  run: (binary, input) => spawnSync(binary, ['validate-spec'], {
    input, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  }),
};

export function unavailableValidation(
  mode: DaemonValidationMode, reason: Unavailable, detail = '', binary?: string,
): Result {
  const message = `${binary === undefined ? 'relayflowd' : `relayflowd at ${binary}`}: ${detail || reason.replaceAll('_', ' ')}. `
    + 'Daemon acceptance is unproven; an already attached daemon from another build is not checked.';
  return {
    validation: { mode: 'local', reason, ...(binary === undefined ? {} : { binary }) },
    diagnostics: mode === 'required'
      ? [{ severity: 'refusal', kind: 'daemon_validation_unavailable', message }]
      : reason === 'disabled' || reason === 'not_reached' || reason === 'relayflowd_not_found'
        ? [] : [{ severity: 'warning', kind: 'daemon_unvalidated', message }],
  };
}

/** Same spec value run.start submits, in canonical form; no socket or run. */
export function validateSpecWithDaemon(
  flow: FlowSpec, mode: DaemonValidationMode, deps: DaemonValidationDeps = defaults,
): Result {
  if (mode === 'off') return unavailableValidation(mode, 'disabled');
  let submitted: ReturnType<typeof toKernelSpec>;
  let input: string;
  try { submitted = toKernelSpec(flow); input = canonicalize(submitted); }
  catch (error) {
    // run refuses this lowering too: degrading to local would fail open.
    const errors = error instanceof CompileError ? error.errors : [String(error)];
    return { validation: { mode: 'local', reason: 'not_reached' },
      diagnostics: [{ severity: 'refusal', kind: 'invalid_spec', message: errors.join('; '), errors }] };
  }
  let binary: string;
  try { binary = deps.resolveBinary(); }
  catch (error) {
    const reason = error instanceof RelayflowdNotFoundError
      ? error.attempts[0]?.startsWith('RELAYFLOWD_BIN=') ? 'relayflowd_bin_invalid' : 'relayflowd_not_found'
      : 'spawn_failed';
    return unavailableValidation(mode, reason, String(error));
  }
  try {
    const result = deps.run(binary, input);
    if (result.error) return unavailableValidation(mode,
      (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'timed_out' : 'spawn_failed', result.error.message, binary);
    let verdict: unknown;
    try { verdict = JSON.parse(result.stdout); } catch { /* Old binaries have no envelope. */ }
    if (!isVerdict(verdict)) return unavailableValidation(mode, 'no_verdict',
      'no validation verdict (the binary may predate validate-spec)', binary);
    if (verdict.protocol !== PROTOCOL_VERSION) return unavailableValidation(mode, 'protocol_mismatch',
      `validator protocol ${verdict.protocol}, SDK protocol ${PROTOCOL_VERSION}`, binary);
    const validation: DaemonValidation = { mode: 'daemon', binary,
      protocol: verdict.protocol, specVersion: verdict.spec_version };
    if (verdict.ok) return { validation, diagnostics: [] };
    const message = verdict.error.message;
    const index = /steps\[(\d+)\]/.exec(message)?.[1];
    const stepId = index === undefined ? undefined : submitted.steps[Number(index)]?.id;
    const generated = stepId !== undefined && !flow.steps.some(step => step.id === stepId);
    return { validation, diagnostics: [{ severity: 'refusal', kind: 'invalid_spec',
      message: message + (generated ? `\nStep "${stepId}" is generated by this compiler's gate lowering, not declared in the flow; `
        + 'the installed relayflowd and this @relayflows/sdk disagree (SDK lowering bug). Report this rather than editing the flow.' : ''),
      errors: [message], ...(stepId === undefined ? {} : { stepId }) }] };
  } catch (error) { return unavailableValidation(mode, 'spawn_failed', String(error), binary); }
}

type Verdict = { protocol: number; spec_version: string } &
  ({ ok: true } | { ok: false; error: { code: 'invalid_spec'; message: string } });
function isVerdict(value: unknown): value is Verdict {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<Verdict>;
  return Number.isInteger(v.protocol) && typeof v.spec_version === 'string'
    && (v.ok === true || (v.ok === false && v.error?.code === 'invalid_spec' && typeof v.error.message === 'string'));
}

export function validationAnnotation(validation?: DaemonValidation): string {
  return validation?.mode === 'daemon'
    ? ` [validated by relayflowd at ${validation.binary}, protocol ${validation.protocol}]`
    : ` [local only: ${(validation?.reason ?? 'not_reached').replaceAll('_', ' ')}, so daemon acceptance is unproven]`;
}
