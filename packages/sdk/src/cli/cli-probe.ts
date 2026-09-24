import { accessSync, constants } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { agentEnvironment, brokerEnvironment } from '../communication/environment.js';
import { adapterIdentification, authenticationProbe, cliAdapterKind, displayInvocation,
  modelReadinessProbe, type CliInvocation } from '../cli-adapter.js';
import { MODEL_ENV } from '../worker-cli.js';
import { CliProbeError, type CliProbeResult } from '../preflight.js';

interface ProbeRequest {
  executable: string;
  directory: string;
  invocation: CliInvocation;
  environment: NodeJS.ProcessEnv;
}
interface ProbeOutput { status: number | null; stdout: string; stderr: string }

/** One decision sequence; checking uses synchronous I/O, live flows yield the loop. */
export function probeCli(...args: Parameters<typeof probeSequence>): CliProbeResult {
  return driveSync(probeSequence(...args));
}

export async function probeCliAsync(...args: Parameters<typeof probeSequence>): Promise<CliProbeResult> {
  const sequence = probeSequence(...args);
  let next = sequence.next();
  while (!next.done) next = sequence.next(await runProbeAsync(next.value));
  return next.value;
}

export function resolveExecutable(command: string, directory: string): string | undefined {
  return driveSync(executableSequence(command, directory));
}

function driveSync<T>(sequence: Generator<ProbeRequest, T, ProbeOutput>): T {
  let next = sequence.next();
  while (!next.done) {
    const request = next.value;
    const result = spawnSync(request.executable, request.invocation.args, {
      ...probeOptions(request),
      // Preserve the old synchronous probe contract: provider CLIs must not
      // inherit a readable stdin that can block auth/identify probes.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const failure = classifySpawnFailure(result.error, result.signal, request.invocation.timeoutMs);
    if (failure !== undefined) throw failure;
    next = sequence.next({ status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
  }
  return next.value;
}

function probeOptions({ directory, invocation, environment }: ProbeRequest) {
  const env = { ...environment };
  delete env[MODEL_ENV];
  if (invocation.modelEnv !== undefined) env[MODEL_ENV] = invocation.modelEnv;
  return { cwd: directory, encoding: 'utf8' as const, timeout: invocation.timeoutMs,
    maxBuffer: 1024 * 1024, env };
}

function runProbeAsync(request: ProbeRequest): Promise<ProbeOutput> {
  return new Promise((resolve, reject) => {
    const child = execFile(request.executable, request.invocation.args, probeOptions(request),
      (error, stdout, stderr) => {
        // Numeric exit codes are probe results; launch, timeout, signal and buffer
        // errors are failures to collect a fact, just as in the synchronous driver.
        if (error?.killed && typeof error.code !== 'string') return reject(new CliProbeError(`timeout:${request.invocation.timeoutMs}ms`));
        const failure = classifySpawnFailure(
          error !== null && typeof error.code !== 'number' && error.signal == null ? error : undefined,
          error?.signal ?? null, request.invocation.timeoutMs);
        if (failure !== undefined) return reject(failure);
        resolve({ status: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
          stdout, stderr });
      });
    child.stdin?.end();
  });
}

function* probeSequence(
  cli: string,
  directory: string,
  model?: string,
  execution?: 'managed',
): Generator<ProbeRequest, CliProbeResult, ProbeOutput> {
  const executable = yield* executableSequence(cli, directory);
  if (executable === undefined) return { exists: false, authenticated: false };
  const kind = cliAdapterKind(executable);
  // Relay owns interactive CLI launch/injection. Its generic PTY path is not
  // the headless wrapper protocol; do not demand that protocol from Gemini,
  // Cursor, OpenCode, or other interactive tools. Never invent an auth pass.
  if (execution === 'managed' && kind === 'relayflows-wrapper-v1') {
    return { exists: true, supported: true, authenticated: 'unverified' };
  }
  const environment = execution === 'managed'
    ? { ...brokerEnvironment(process.env), ...agentEnvironment(executable) } : process.env;
  const probe = (invocation: CliInvocation): ProbeRequest => ({ executable, directory, invocation, environment });
  const identification = adapterIdentification(kind);
  const identified = yield probe(identification.invocation);
  if (
    identified.status !== 0
    || (identification.expectedStdout !== undefined
      && identified.stdout.trim() !== identification.expectedStdout)
  ) {
    return { exists: true, supported: false, authenticated: false };
  }
  const auth = authenticationProbe(kind);
  const authCommand = displayInvocation(cli, auth);
  if (model === undefined) {
    return {
      exists: true,
      supported: true,
      authenticated: (yield probe(auth)).status === 0,
      authCommand,
    };
  }

  const scoped = modelReadinessProbe(kind, model);
  const modelCommand = displayInvocation(cli, scoped);
  // A successful real provider round trip (or identified wrapper probe)
  // proves both auth and exact-model access. On failure, run the adapter's
  // actual auth command solely to classify auth vs model access truthfully.
  if ((yield probe(scoped)).status === 0) {
    return {
      exists: true,
      supported: true,
      authenticated: true,
      modelAvailable: true,
      authCommand,
      modelCommand,
    };
  }
  const authProbe = yield probe(auth);
  const authenticated = authProbe.status === 0;
  return {
    exists: true,
    supported: true,
    authenticated,
    modelAvailable: false,
    authCommand,
    modelCommand,
    // Only on failure: on success there is nothing to explain, and the output
    // is the most identity-bearing thing this function touches.
    ...(authenticated
      ? {}
      : {
        authExitCode: authProbe.status,
        authFailureDetail: redactProbeOutput(
          `${authProbe.stderr}${authProbe.stdout}`,
        ).trim().slice(0, 500),
      }),
  };
}

/**
 * Redact anything that looks like a credential or an account identifier.
 *
 * `auth status` output is diagnostic, but it is also the one place an account
 * email, org id or token fragment can appear. The point of surfacing it is to
 * say WHY a probe failed, which survives redaction; leaking an identity into a
 * refusal message that gets pasted into issues does not.
 */
function redactProbeOutput(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<redacted-email>')
    .replace(/\b(sk|pk|oat|rt)[-_][A-Za-z0-9._-]{8,}/gi, '<redacted-token>')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '<redacted-hex>');
}

function* executableSequence(command: string, directory: string): Generator<ProbeRequest, string | undefined, ProbeOutput> {
  if (command.includes('/') || isAbsolute(command)) {
    const path = isAbsolute(command) ? command : resolve(directory, command);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      return undefined;
    }
  }
  const result = yield { executable: 'which', directory: process.cwd(),
    invocation: { args: [command], timeoutMs: 5_000 }, environment: process.env };
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function classifySpawnFailure(
  error: Error | undefined,
  signal: NodeJS.Signals | null,
  timeoutMs: number,
): CliProbeError | undefined {
  if (error !== undefined) {
    const detail = (error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
      ? `timeout:${timeoutMs}ms` as const
      : 'spawn_failed' as const;
    return new CliProbeError(detail);
  }
  return signal === null ? undefined : new CliProbeError(`signal:${signal}`);
}
