import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { CliIo } from './cli.js';

const DEBOUNCE_MS = 150;
type ExitCode = 0 | 1 | 2 | 3;

/** A runner around the ordinary CLI, with a fresh module cache for every check. */
export async function watchCheck(path: string, json: boolean, io: CliIo): Promise<ExitCode> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    return await watchChecks({
      path,
      signal: controller.signal,
      check: () => checkOnce(path, json, io),
      clear: () => { if (!json) io.stdout('\x1b[2J\x1b[H'); },
    });
  } catch (error) {
    io.stderr(`REFUSED [input_unreadable] Could not watch "${path}": ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

/** Inject the check and cancellation, just as the SDK pollers inject their I/O. */
export async function watchChecks(options: {
  path: string;
  signal: AbortSignal;
  check: () => Promise<ExitCode>;
  clear: () => void;
}): Promise<ExitCode> {
  const watchers = new Map<string, FSWatcher>();
  const imports = new Map<string, string[]>();
  let paths = new Set<string>();
  let lastCode: ExitCode = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let stopped = options.signal.aborted;
  let wake: (() => void) | undefined;
  let watchError: Error | undefined;

  const changed = (): void => {
    if (stopped) return;
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; wake?.(); }, DEBOUNCE_MS);
  };
  const stop = (): void => {
    stopped = true;
    clearTimeout(timer);
    timer = undefined;
    wake?.();
  };
  const refresh = (): void => {
    paths = discoverWatchPaths(options.path, imports);
    const directories = new Set<string>();
    for (const path of paths) {
      let directory = dirname(path);
      while (!existsSync(directory) && dirname(directory) !== directory) directory = dirname(directory);
      directories.add(directory);
      if (watchers.has(directory)) continue;
      // Watch directories so atomic editor saves and delete/recreate keep working.
      const watcher = watch(directory, (_event, filename) => {
        const changedPath = filename === null ? undefined : resolve(directory, filename.toString());
        if (changedPath === undefined || [...paths].some((target) =>
          target === changedPath || target.startsWith(`${changedPath}${sep}`))) changed();
      });
      watcher.on('error', (error) => { watchError = error; stop(); });
      watchers.set(directory, watcher);
    }
    for (const [directory, watcher] of watchers) {
      if (!directories.has(directory)) { watcher.close(); watchers.delete(directory); }
    }
  };

  options.signal.addEventListener('abort', stop, { once: true });
  try {
    refresh();
    let first = true;
    while (!stopped) {
      if (!first && (!pending || timer !== undefined)) {
        await new Promise<void>((resolveWake) => { wake = resolveWake; });
        wake = undefined;
        continue;
      }
      pending = false;
      refresh();
      if (!first) options.clear();
      first = false;
      lastCode = await options.check();
      // A change while checking remains pending. Never overlap checks or lose
      // a save merely because its debounce deadline elapsed during a check.
      if (!stopped) refresh();
    }
    if (watchError !== undefined) throw watchError;
    return lastCode;
  } finally {
    options.signal.removeEventListener('abort', stop);
    clearTimeout(timer);
    for (const watcher of watchers.values()) watcher.close();
  }
}

function discoverWatchPaths(path: string, imports: Map<string, string[]>): Set<string> {
  const paths = new Set<string>();
  const visit = (file: string): void => {
    if (paths.has(file)) return;
    paths.add(file);
    try {
      const value: unknown = parseYaml(readFileSync(file, 'utf8'));
      const use = typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)['use'] : undefined;
      imports.set(file, Array.isArray(use) ? use.filter((entry): entry is string =>
        typeof entry === 'string' && (entry.startsWith('./') || entry.startsWith('../'))) : []);
    } catch {
      // Keep the previous graph while an editor has left this file incomplete.
      // The ordinary check owns all parse and validation diagnostics.
    }
    for (const dependency of imports.get(file) ?? []) visit(resolve(dirname(file), dependency));
  };
  visit(resolve(path));
  for (const file of imports.keys()) { if (!paths.has(file)) imports.delete(file); }
  let directory = dirname(resolve(path));
  while (true) {
    const candidate = join(directory, 'flows.json');
    paths.add(candidate);
    try { accessSync(candidate, constants.R_OK); break; }
    catch { /* Match check's nearest-readable-config discovery. */ }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return paths;
}

function checkOnce(path: string, json: boolean, io: CliIo): Promise<ExitCode> {
  // Importing an authored TS file in this process again would return its stale
  // cached definition (including transitive imports). A fresh CLI process uses
  // precisely the same check pipeline and reporting as a one-shot invocation.
  const entry = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './cli.ts' : './cli.js', import.meta.url));
  return new Promise((resolveCode, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, entry, 'check', ...(json ? ['--json'] : []), path], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Ctrl-C belongs to the watcher; let an active check finish so its report
      // and exit status remain a pair, then release all resources.
      detached: true,
    });
    const forward = (stream: NodeJS.ReadableStream, write: (line: string) => void): void => {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        pending += chunk;
        let end: number;
        while ((end = pending.indexOf('\n')) >= 0) {
          write(pending.slice(0, end));
          pending = pending.slice(end + 1);
        }
      });
      stream.on('end', () => { if (pending) write(pending); });
    };
    forward(child.stdout, io.stdout);
    forward(child.stderr, io.stderr);
    child.once('error', reject);
    child.once('close', (code) => resolveCode(code === 0 || code === 2 || code === 3 ? code : 1));
  });
}
