import { readFile, lstat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { sealBundle, verifyBundle, type BundleFile } from '../bundle.js';
import { canonicalize } from '../canonical.js';
import { compileSpec, toKernelSpec } from '../compile.js';
import { preflight } from '../preflight.js';
import { buildTypescript } from '../bundle-typescript.js';
import { readProjectConfig } from './check.js';
import type { CliIo } from '../cli.js';
import type { FlowSpec } from '../spec.js';

export interface BuildArgs { command: 'build'; value: string; out?: string; verify: boolean }

export function parseBuildArgs(args: readonly string[]): BuildArgs | undefined {
  if (args[0] === '--verify') {
    return args.length === 2 && !args[1]!.startsWith('-')
      ? { command: 'build', value: args[1]!, verify: true } : undefined;
  }
  let out: string | undefined;
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--out') {
      if (out !== undefined || args[i + 1] === undefined || args[i + 1]!.startsWith('-')) return undefined;
      out = args[++i];
    } else if (arg.startsWith('-') || value !== undefined) return undefined;
    else value = arg;
  }
  return value === undefined ? undefined : { command: 'build', value, out, verify: false };
}

export async function runBuild(args: BuildArgs, io: CliIo): Promise<0 | 2> {
  try {
    if (args.verify) {
      io.stdout(`VERIFIED sha256:${await verifyBundle(args.value)}`);
      return 0;
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
    files.push({ path: 'lockfile.json', data: canonicalize({ version: 1, adapters: [] }) });
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
    ...(config.path !== undefined ? { modelRegistryPath: config.path } : {}),
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
  return sealBundle({ name: authoring.name ?? 'flow', out, files,
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
  const captured = new Map<string, string>();
  async function capture(path: string): Promise<string> {
    if (!path.includes('/')) return path;
    if (!path.startsWith('./') || path.split('/').includes('..') || path.includes('\\')) {
      throw new Error(`${path}: bundle file references must start with ./ and stay inside the flow directory`);
    }
    if (captured.has(path)) return captured.get(path)!;
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
    captured.set(path, `./${target}`);
    return `./${target}`;
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
