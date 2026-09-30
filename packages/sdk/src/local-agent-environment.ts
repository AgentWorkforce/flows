import { closeSync, readSync } from 'node:fs';

/**
 * Inherited descriptor carrying environment values that only local agent/LLM
 * subprocesses may receive. The flows process consumes and closes it before
 * loading authored code, so that code cannot inherit or read the credentials.
 */
export const LOCAL_AGENT_ENV_FD = 'FLOWS_LOCAL_AGENT_ENV_FD';

const MAX_BYTES = 64 * 1024;

export function localAgentEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = { ...base };
  const rawFd = environment[LOCAL_AGENT_ENV_FD];
  delete environment[LOCAL_AGENT_ENV_FD];
  if (rawFd === undefined) return environment;
  // Every later child — especially the authored runtime — inherits process.env.
  // Remove the capability marker before any authored module can be imported.
  if (base === process.env) delete process.env[LOCAL_AGENT_ENV_FD];

  if (!/^[0-9]+$/.test(rawFd)) throw new Error(`${LOCAL_AGENT_ENV_FD} must name an inherited file descriptor`);
  const fd = Number(rawFd);
  if (!Number.isSafeInteger(fd) || fd < 3 || fd > 255) {
    throw new Error(`${LOCAL_AGENT_ENV_FD} must name an inherited file descriptor`);
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(8 * 1024, MAX_BYTES + 1 - bytes));
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      bytes += read;
      if (bytes > MAX_BYTES) throw new Error('local agent environment payload exceeds 64 KiB');
      chunks.push(chunk.subarray(0, read));
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'local agent environment payload exceeds 64 KiB') throw error;
    throw new Error('local agent environment payload could not be read');
  } finally {
    try { closeSync(fd); } catch { /* The descriptor is unusable either way. */ }
  }

  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
  catch { throw new Error('local agent environment payload is not valid JSON'); }
  if (!plainObject(parsed)) throw new Error('local agent environment payload must be an object of strings');
  const agentEnvironment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key.length === 0 || key.includes('=') || key.includes('\0') || typeof value !== 'string' || value.includes('\0')) {
      throw new Error('local agent environment payload must be an object of valid environment strings');
    }
    if (key !== LOCAL_AGENT_ENV_FD) agentEnvironment[key] = value;
  }
  return { ...environment, ...agentEnvironment };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
