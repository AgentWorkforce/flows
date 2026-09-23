import { readFile, lstat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { sealBundle, verifyBundle, type BundleFile } from '../bundle.js';
import { collectBundleExtensions, verifyBundlePluginLock } from '../bundle-extensions.js';
import { canonicalize } from '../canonical.js';
import { compileSpec, toKernelSpec } from '../compile.js';
import { preflight } from '../preflight.js';
import { buildTypescript } from '../bundle-typescript.js';
import { checkBuildableFlow, readProjectConfig, type CheckReport } from './check.js';
import type { CliIo } from '../cli.js';
import type { FlowSpec } from '../spec.js';

export interface BuildArgs { command: 'build'; value: string; out?: string; verify: boolean; json: boolean }

/**
 * `--verify` is an ordinary flag, not a leading mode token: the command surface
 * lists it beside `--out` and `--json`, so every order the help implies has to
 * parse (`build --verify --json <dir>` and `build <dir> --verify` alike).
 *
 * `--out` is the one combination genuinely refused: it names where a build
 * writes, and a verify builds nothing, so accepting the pair would silently
 * ignore the destination. The surface says so in the option's description.
 */
export function parseBuildArgs(args: readonly string[]): BuildArgs | undefined {
  let out: string | undefined;
  let value: string | undefined;
  let json = false;
  let verify = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--out') {
      if (out !== undefined || args[i + 1] === undefined || args[i + 1]!.startsWith('-')) return undefined;
      out = args[++i];
    } else if (arg === '--json') {
      if (json) return undefined;
      json = true;
    } else if (arg === '--verify') {
      if (verify) return undefined;
      verify = true;
    } else if (arg.startsWith('-') || value !== undefined) return undefined;
    else value = arg;
  }
  if (value === undefined || (verify && out !== undefined)) return undefined;
  return { command: 'build', value, out, verify, json };
}

/**
 * Emit a check report in the same shape `flows check` uses so build-time
 * refusals are consumable by the same tooling.
 */
function emitBuildCheckReport(report: CheckReport, json: boolean, io: CliIo): void {
  for (const diagnostic of report.diagnostics) {
    if (diagnostic.severity !== 'refusal') continue;
    io.stderr(`REFUSED [${diagnostic.kind}] ${diagnostic.message}`);
  }
  if (json) io.stdout(JSON.stringify(report));
}

export async function runBuild(args: BuildArgs, io: CliIo): Promise<0 | 2> {
  try {
    if (args.verify) {
      const digest = `sha256:${await verifyBundle(args.value)}`;
      await verifyBundlePluginLock(args.value);
      // `--json` is declared on the verb, not on one of its forms: a verify
      // under it emits the same single object a `--json` consumer parses.
      if (args.json) io.stdout(JSON.stringify({ ok: true, verified: true, bundle: args.value, digest }));
      else io.stdout(`VERIFIED ${digest}`);
      return 0;
    }
    // Gate the build on the same preflight pipeline `flows check` uses.
    // Refusals never leave partial artifacts — no file capture, no canonical
    // spec write, no digest computation, no bundle directory creation. A
    // previous `dist/flows/<name>@sha256:<hex>/` directory from an earlier
    // successful build is not touched (buildFlow is never called).
    const gate = await checkBuildableFlow(args.value);
    if (!gate.report.ok) {
      emitBuildCheckReport(gate.report, args.json, io);
      return 2;
    }
    // `ok` means "no refusal", not "no diagnostics". Build defers environment
    // probes, so probe-shaped warnings (`command_unprovable`, ...) are expected
    // here and stay in preflight.json; `budget_unmetered` does not depend on a
    // probe and changes what the dollar budget enforces, so it is printed.
    for (const diagnostic of gate.report.diagnostics) {
      if (diagnostic.kind === 'budget_unmetered') io.stderr(`WARNING [${diagnostic.kind}] ${diagnostic.message}`);
    }
    io.stdout(await buildFlow(args.value, args.out ?? 'dist/flows', io.stderr));
    return 0;
  } catch (error) {
    io.stderr(`REFUSED [bundle_invalid] ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

/** Build checks never probe credentials, workers, or the author's PATH. */
export async function buildFlow(path: string, out: string, warn: (line: string) => void): Promise<string> {
  const input = resolve(path);
  const directory = dirname(input);
  const files: BundleFile[] = [];
  let authoring: FlowSpec;
  let authored = false;
  let compiler: string | undefined;
  if (extname(input) === '.ts') {
    const result = await buildTypescript(input);
    authoring = result.spec;
    authored = result.authored;
    compiler = result.compiler;
    files.push(...result.files);
  } else if (['.yaml', '.yml'].includes(extname(input))) {
    authoring = compileSpec(parse(await readFile(input, 'utf8')));
    files.push({ path: 'lockfile.json', data: canonicalize({ version: 2, plugins: [] }) });
  } else throw new Error('build expects a .yaml, .yml, or .ts flow');

  // The current preflight API reports uncollected environment facts as
  // probe_failed. Preserve that truthful report verbatim and separately declare
  // the deployment obligations; never manufacture successful auth probes.
  //
  // Load the nearest flows.json so declared model allowlists and the project
  // CLI participate in build-time preflight. Without them a declared `model:`
  // that appears in flows.json/models refuses the whole build as
  // `model_unknown`, because preflight defaults treat "no registry" as "no
  // model is known" and only environment probes (deferred here) would rescue
  // it. Model existence is a build-provable fact; only the live probe is not.
  const config = readProjectConfig(directory);
  const report = preflight(authoring, {
    ...(config.cli !== undefined ? { projectCli: config.cli } : {}),
    ...(config.path !== undefined ? { projectConfigPath: config.path } : {}),
    projectSearchStart: directory,
    models: config.models,
    ...(config.modelRegistryPath !== undefined ? { modelRegistryPath: config.modelRegistryPath } : {}),
    probes: {
      cli: () => { throw new Error('deferred to deployment'); },
      executor: () => { throw new Error('deferred to deployment'); },
      command: () => { throw new Error('deferred to deployment'); },
    },
  });
  const refusals = report.diagnostics.filter(d => d.severity === 'refusal' && d.kind !== 'probe_failed');
  if (refusals.length > 0) throw new Error(refusals.map(d => `[${d.kind}] ${d.message}`).join('\n'));
  authoring = await captureFiles(authoring, directory, files);
  files.push(
    { path: 'spec.canonical.json', data: canonicalize(toKernelSpec(authoring)) },
    { path: 'preflight.json', data: canonicalize(report) },
    { path: 'metadata.json', data: canonicalize({
      version: 1, platform: { os: process.platform, arch: process.arch },
      executables: files.filter(file => file.path === 'flow' || file.executable).map(file => file.path).sort(),
      kind: authored ? 'authored-typescript' : 'declarative',
      ...(compiler === undefined ? {} : { compiler }),
      preflight: { buildPassed: true, deferred: ['commands', 'credentials', 'workers', 'mcp_servers'],
        ...(authored ? { dynamicSteps: 'exported spec declaration checked; body was not executed during build' } : {}) },
    }) },
  );
  const extensions = await collectBundleExtensions(input);
  const bundled = files.filter(file => file.path !== 'lockfile.json');
  bundled.push({ path: 'lockfile.json', data: canonicalize(extensions.lock) }, ...extensions.files);
  return sealBundle({ name: authoring.name ?? 'flow', out, files: bundled,
    repo: await repositoryRoot(directory), warn });
}

async function repositoryRoot(start: string): Promise<string> {
  for (let dir = start; ; dir = dirname(dir)) {
    try { await lstat(join(dir, '.git')); return dir; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (dirname(dir) === dir) return start;
  }
}

/** Relative CLI executables are the file references in the current spec schema.
 * Shell commands are opaque; explicit ./file words are captured without
 * interpreting substitutions or running a shell at build time. */
async function captureFiles(flow: FlowSpec, directory: string, files: BundleFile[]): Promise<FlowSpec> {
  // Cache the in-flight *promise*, not the resolved string. Two concurrent
  // captures of the same path (Promise.all over named agents that share a CLI)
  // both pass a `captured.has(path)` guard before either has finished awaiting
  // its lstat/readFile, so both would push the same `assets/...` entry -- and
  // sealBundle then refuses the whole flow as a duplicate. Storing the promise
  // dedups on the first synchronous look-up.
  const captured = new Map<string, Promise<string>>();
  function capture(path: string): Promise<string> {
    if (!path.includes('/')) return Promise.resolve(path);
    if (!path.startsWith('./') || path.split('/').includes('..') || path.includes('\\')) {
      return Promise.reject(new Error(`${path}: bundle file references must start with ./ and stay inside the flow directory`));
    }
    const existing = captured.get(path);
    if (existing !== undefined) return existing;
    const pending = (async () => {
      const parts = path.slice(2).split('/');
      if (parts.some(p => p === '' || p === '.')) throw new Error(`${path}: invalid file reference`);
      let executable = false;
      for (let i = 1; i <= parts.length; i++) {
        const stat = await lstat(join(directory, ...parts.slice(0, i)));
        if (i === parts.length ? !stat.isFile() : !stat.isDirectory()) throw new Error(`${path}: expected regular file without symlinks`);
        if (i === parts.length) executable = (stat.mode & 0o111) !== 0;
      }
      const target = `assets/${parts.join('/')}`;
      files.push({ path: target, data: await readFile(join(directory, ...parts)), executable });
      return `./${target}`;
    })();
    captured.set(path, pending);
    return pending;
  }
  // Capture the flow-level `cli` default and every named-agent `cli` BEFORE
  // walking steps. Otherwise a step that inherits its CLI from the flow header
  // or an agents-map entry never emits its own `cli`, so the step-level walk
  // below misses it, the executable never enters the bundle, and the sealed
  // spec still points at the author's absolute path outside the bundle.
  const flowCli = flow.cli !== undefined ? await capture(flow.cli) : undefined;
  const agents: FlowSpec['agents'] = flow.agents === undefined ? undefined
    : Object.fromEntries(await Promise.all(Object.entries(flow.agents).map(
        async ([name, agent]) => [name, { ...agent, cli: await capture(agent.cli) }] as const,
      )));
  const compiled = toKernelSpec(flow);
  // Lower named/flow CLI resolution first so every runtime reference is bound.
  const steps: FlowSpec['steps'] = [];
  for (const [index, step] of flow.steps.entries()) {
    if (step.type !== 'deterministic') {
      const lowered = compiled.steps[index];
      const cli = lowered && lowered.type !== 'deterministic' ? lowered.cli : undefined;
      steps.push(cli === undefined ? step : { ...step, cli: await capture(cli) });
      continue;
    }
    let command = step.command;
    const references = [...command.matchAll(/(?:^|[\s;|&<>])(?:"(\.\/[^"$`]+)"|'(\.\/[^']+)'|(\.\/[^\s;|&<>"'$`]+))/g)];
    // Replace only each complete matched word, from right to left so offsets
    // stay valid and similarly prefixed filenames cannot rewrite one another.
    for (const match of references.reverse()) {
      const ref = (match[1] ?? match[2] ?? match[3])!;
      const start = match.index! + match[0].indexOf(ref);
      command = command.slice(0, start) + await capture(ref) + command.slice(start + ref.length);
    }
    if (/^\s*["']?\//.test(command)) throw new Error(`${step.id}: absolute command paths cannot be bundled`);
    steps.push({ ...step, command });
  }
  return {
    ...flow,
    ...(flowCli !== undefined ? { cli: flowCli } : {}),
    ...(agents !== undefined ? { agents } : {}),
    steps,
  };
}
