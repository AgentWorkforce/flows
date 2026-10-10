// What a flow evaluation judges, by content: the flow version.
//
// For a flow file the version is the sha256 of a manifest of every local
// source the run reads, not of the entry file alone. Editing a helper module,
// a `use`d flow, or the project's extension lock changes what executes, so it
// must change the version too — otherwise `expectVersion` would accept code it
// never judged. Packages under node_modules are not part of the manifest; they
// are pinned by the project's own lockfile, which is.

import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { canonicalize, specHash } from './canonical.js';
import { compileSpec, toKernelSpec } from './compile.js';
import { FlowEvalError } from './flow-eval-error.js';
import { findPluginProject } from './plugin-loader.js';
import type { FlowSpec } from './spec.js';

/** A flow source path (`.flow.ts`, `.flow.yaml`, spec JSON) or an in-memory spec. */
export type FlowEvalTarget = { path: string } | FlowSpec;

export interface FlowEvalVersion {
  /** `sha256:<hex>` over the manifest (or the kernel spec hash for an in-memory spec). */
  version: string;
  /** Manifest paths, relative to the entry's directory; empty for an in-memory spec. */
  files: string[];
}

/** Most local source files one version may span; past it the evaluation is refused, not truncated. */
export const MAX_FLOW_EVAL_SOURCES = 2_000;

const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'];
const PROJECT_FILES = ['flows.json', 'flows.lock.json', 'package-lock.json', 'bun.lock', 'pnpm-lock.yaml', 'yarn.lock'];

export function isPathTarget(flow: FlowEvalTarget): flow is { path: string } {
  return typeof (flow as { path?: unknown }).path === 'string' && !('steps' in flow);
}

/** The version string alone. */
export async function flowEvalVersion(flow: FlowEvalTarget): Promise<string> {
  return (await flowEvalSources(flow)).version;
}

/** The version and the files it covers. */
export async function flowEvalSources(flow: FlowEvalTarget): Promise<FlowEvalVersion> {
  if (!isPathTarget(flow)) return { version: `sha256:${specHash(toKernelSpec(compileSpec(flow)))}`, files: [] };
  let entry: string;
  try {
    entry = await realpath(flow.path);
  } catch {
    throw new FlowEvalError('unreadable_flow', `Flow "${flow.path}" is not readable.`);
  }
  const root = dirname(entry);
  const hashes = new Map<string, string>();
  const missing = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (hashes.has(file)) continue;
    if (hashes.size >= MAX_FLOW_EVAL_SOURCES) {
      throw new FlowEvalError('unreadable_flow', `Flow "${flow.path}" reaches more than ${MAX_FLOW_EVAL_SOURCES} local source files.`);
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch {
      throw new FlowEvalError('unreadable_flow', `Flow source "${file}" is not readable.`);
    }
    hashes.set(file, sha256(bytes));
    if (!/\.(?:[mc]?[jt]s)$/u.test(file)) continue;
    for (const specifier of localSpecifiers(bytes.toString('utf8'))) {
      const target = resolveLocal(dirname(file), specifier);
      if (target === undefined) missing.add(`${relative(root, dirname(file)) || '.'}:${specifier}`);
      else if (!hashes.has(target)) pending.push(target);
    }
  }
  const project = findPluginProject(root);
  if (project !== undefined) {
    for (const name of PROJECT_FILES) {
      const path = join(project, name);
      if (existsSync(path) && !hashes.has(path)) hashes.set(path, sha256(await readFile(path)));
    }
  }
  const files = [...hashes.entries()]
    .map(([path, hash]) => ({ path: relative(root, path) || basename(path), sha256: hash }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // An unresolved import is part of the identity too: creating that file later changes what runs.
  const manifest = { entry: basename(entry), files, missing: [...missing].sort() };
  return {
    version: `sha256:${sha256(canonicalize(manifest))}`,
    files: files.map(file => file.path),
  };
}

/**
 * Relative module specifiers and relative `.flow.ts` string literals (the
 * `use:` header) in a source file. A lexical scan, deliberately: computing a
 * version must never execute the flow.
 */
export function localSpecifiers(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[^'"`;]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/gu,
    /\bimport\s*['"](\.{1,2}\/[^'"]+)['"]/gu,
    /\b(?:import|require)\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/gu,
    /['"](\.{1,2}\/[^'"\s]+\.flow\.ts)['"]/gu,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.add(match[1]!);
  return [...found];
}

function resolveLocal(from: string, specifier: string): string | undefined {
  const base = resolve(from, specifier.replace(/[?#].*$/u, ''));
  const candidates = [base];
  // TypeScript's NodeNext convention: import './x.js' names ./x.ts.
  const swapped = base.replace(/\.([mc]?)js$/u, '.$1ts');
  if (swapped !== base) candidates.push(swapped);
  for (const extension of SOURCE_EXTENSIONS) candidates.push(base + extension);
  for (const extension of SOURCE_EXTENSIONS) candidates.push(join(base, `index${extension}`));
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* next candidate */ }
  }
  return undefined;
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
