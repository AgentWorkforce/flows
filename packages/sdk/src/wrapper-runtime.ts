import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

const WRAPPER_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'USER',
  'LOGNAME',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'WINDIR',
] as const;

export interface WrapperIdentity {
  executable: string;
  fingerprint: string;
}

/** Build a wrapper environment from a closed list; ambient credentials never cross. */
export function wrapperEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of WRAPPER_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Resolve and fingerprint the exact executable that will enter the private protocol. */
export function captureWrapperIdentity(
  cli: string,
  env: NodeJS.ProcessEnv,
): WrapperIdentity {
  const executable = realpathSync(resolveWrapperExecutable(cli, env));
  accessSync(executable, constants.X_OK);
  const stat = statSync(executable, { bigint: true });
  if (!stat.isFile()) throw new Error('resolved wrapper is not a regular file');
  return {
    executable,
    fingerprint: [
      stat.dev,
      stat.ino,
      stat.mode,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
    ].join(':'),
  };
}

export function sameWrapperIdentity(
  cli: string,
  env: NodeJS.ProcessEnv,
  expected: WrapperIdentity,
): boolean {
  try {
    const current = captureWrapperIdentity(cli, env);
    return current.executable === expected.executable
      && current.fingerprint === expected.fingerprint;
  } catch {
    return false;
  }
}

function resolveWrapperExecutable(cli: string, env: NodeJS.ProcessEnv): string {
  if (isAbsolute(cli) || cli.includes('/') || cli.includes('\\')) return resolve(cli);
  const path = env.PATH;
  if (path === undefined) throw new Error('PATH is unavailable while resolving the wrapper');
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const directory of path.split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(directory || '.', `${cli}${extension}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue through the deterministic PATH candidate list.
      }
    }
  }
  throw new Error(`wrapper executable ${JSON.stringify(cli)} was not found on PATH`);
}
