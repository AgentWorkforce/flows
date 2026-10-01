import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { scanDeclarative } from './helpers/shipped-source-declarative-models.js';
import { scanTypeScript } from './helpers/shipped-source-typescript.js';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const MODELS: Record<string, ReadonlySet<string>> = {
  claude: new Set(['claude-sonnet-5', 'claude-opus-5']),
  codex: new Set(['gpt-5.6-sol']),
  'cursor-agent': new Set(['gpt-5.6-sol-high']),
  grok: new Set(['grok-4.7']),
};
const DYNAMIC_PAIR_SOURCE_WAIVERS = new Map([
  [
    'examples/babysitter/babysitter.flow.ts',
    ['`babysitter-${lens}`'],
  ],
  [
    'examples/babysitter/legacy/pr-reviewer.flow.ts',
    ['"review"'],
  ],
  [
    'packages/sdk/scripts/dogfood/close-pr.flow.ts',
    ["'close-pr-repair'"],
  ],
]);

// RelayCron stores these registrations outside the repository, so there is no
// executable launch command for source discovery to find. Keep this manifest in
// lockstep with the schedules documented in ops/AUTONOMY.md.
const REGISTERED_SCHEDULE_SOURCES = new Set([
  'workflows/drive.yaml',
  'workflows/watchdog.yaml',
]);

function filesBelow(path: string, suffix: string): string[] {
  return readdirSync(path).flatMap(entry => {
    if (entry === 'node_modules' || entry === 'dist') return [];
    const file = resolve(path, entry);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) return [];
    return stat.isDirectory() ? filesBelow(file, suffix) : file.endsWith(suffix) ? [file] : [];
  });
}

function activeDeclarativeSources(): ReadonlySet<string> {
  const operationalFiles = ['.github', 'ops', 'scripts'].flatMap(directory =>
    ['.yml', '.yaml', '.sh'].flatMap(suffix => filesBelow(resolve(ROOT, directory), suffix)));
  const active = new Set(REGISTERED_SCHEDULE_SOURCES);
  const command = /\b(?:agent-relay\s+cloud\s+run|flows\s+run)[\s\\]+(?:\.\.\/gate-files\/)?(workflows\/[A-Za-z0-9._/-]+\.ya?ml)/gu;
  for (const path of operationalFiles) {
    for (const match of readFileSync(path, 'utf8').matchAll(command)) {
      const source = match[1];
      if (source !== undefined && existsSync(resolve(ROOT, source))) active.add(source);
    }
  }
  for (const source of active) expect(existsSync(resolve(ROOT, source)), `${source}: active workflow source must exist`).toBe(true);
  return active;
}

function expectSupported(pair: string, where: string): void {
  const slash = pair.indexOf('/');
  const cli = pair.slice(0, slash);
  const model = pair.slice(slash + 1);
  expect(MODELS[cli], `${where}: disabled or unknown CLI ${cli}`).toBeDefined();
  expect(MODELS[cli]?.has(model), `${where}: unsupported pair ${pair}`).toBe(true);
}

describe('first-party shipped source model pins', () => {
  it('gives every TypeScript agent and LLM an explicit supported pair or a pinned named-agent declaration', () => {
    const paths = [
      ...filesBelow(resolve(ROOT, 'examples'), '.flow.ts'),
      resolve(ROOT, 'examples/babysitter/hosted.ts'),
      ...filesBelow(resolve(ROOT, 'workflows'), '.flow.ts'),
      ...filesBelow(resolve(ROOT, 'packages/sdk/scripts/dogfood'), '.flow.ts'),
    ];
    const seenDynamicWaivers = new Set<string>();
    for (const path of paths) {
      const name = relative(ROOT, path);
      const result = scanTypeScript(path);
      for (const pair of [...result.pairs, ...result.namedPairs]) expectSupported(pair, name);
      expect(result.incompleteNamed, `${name}: every named agent must declare a literal cli and model`).toEqual([]);
      expect(result.invalidFlowHeaders, `${name}: flow headers must be inline and statically auditable`).toEqual([]);
      expect(
        result.dollarBudgetsWithoutTokenCeilings,
        `${name}: current model aliases have no verified frozen price; dollar budgets need at most 100,000 tokens per dollar`,
      ).toEqual([]);
      if (result.unresolved.length > 0) {
        const expectedCalls = DYNAMIC_PAIR_SOURCE_WAIVERS.get(name);
        expect(expectedCalls, `${result.unresolved.map(item => item.where).join('\n')}\nDynamic pairs need an exact tested waiver.`).toBeDefined();
        expect(result.unresolved.map(item => item.call), `${name}: dynamic waivers are call-exact and count-exact`).toEqual(expectedCalls);
        seenDynamicWaivers.add(name);
      }
      expect(result.missing, `${name}: omitted pairs must resolve call-exactly through complete named agents`).toEqual([]);
    }
    expect(seenDynamicWaivers).toEqual(new Set(DYNAMIC_PAIR_SOURCE_WAIVERS.keys()));
  });

  it('gives every current declarative and active v1 Cloud agent/LLM an effective supported CLI/model pair', () => {
    const paths = [
      ...filesBelow(resolve(ROOT, 'examples'), '.yaml'),
      ...filesBelow(resolve(ROOT, 'examples'), '.yml'),
      ...filesBelow(resolve(ROOT, 'workflows'), '.yaml'),
      ...filesBelow(resolve(ROOT, 'workflows'), '.yml'),
    ];
    let currentFiles = 0;
    let modelSteps = 0;
    let activeV1Files = 0;
    let activeV1ModelSteps = 0;
    const activeV1Sources = activeDeclarativeSources();
    for (const path of paths) {
      const document = parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      const name = relative(ROOT, path);
      const isCurrent = String(document.version) === '0.1.0';
      const isActiveV1 = activeV1Sources.has(name) && !isCurrent;
      if (!isCurrent && !isActiveV1) continue;
      if (isCurrent) currentFiles += 1;
      if (isActiveV1) activeV1Files += 1;
      const result = scanDeclarative(document, name);
      if (isCurrent) modelSteps += result.calls;
      if (isActiveV1) activeV1ModelSteps += result.calls;
      expect(result.missing, `${name}: every declarative agent/LLM needs an effective CLI and explicit model`).toEqual([]);
      for (const pair of result.pairs) expectSupported(pair, name);
    }
    expect(currentFiles).toBe(7);
    expect(modelSteps).toBe(8);
    expect(activeV1Files).toBe(4);
    expect(activeV1ModelSteps).toBe(10);
  });
});
