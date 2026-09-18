import { copyFile, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { flow, github, schedule, webhook } from '@relayflows/surface';
import { getFlowDefinition } from '@relayflows/surface/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAuthoredFlow } from '../src/authored-flow-loader.js';
import { describeFlowRequirements, flowRequirements, harnessFromCli } from '../src/flow-requirements.js';
import type { FlowSpec } from '../src/spec.js';

const EXAMPLES = resolve(process.cwd(), '../../examples');
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** The shipped example, loaded from a directory that resolves @relayflows/surface. */
async function example(name: string) {
  const dir = await mkdtemp(join(tmpdir(), 'flow-requirements-'));
  dirs.push(dir);
  await symlink(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
  const path = join(dir, `${name}.flow.ts`);
  await copyFile(resolve(EXAMPLES, name, `${name}.flow.ts`), path);
  const loaded = await loadAuthoredFlow(path);
  return loaded.getDefinition(loaded.handle);
}

describe('flowRequirements on an authored definition', () => {
  it('names a declared helper and a body-only helper by how each was declared', () => {
    const declared = getFlowDefinition(flow('digest', { tools: { slack: true } }, async (f) => {
      await f.run('true');
    }));
    expect(flowRequirements(declared).integrations).toEqual([{ provider: 'slack', from: 'tools', detail: 'tools.slack' }]);
    const bodyOnly = getFlowDefinition(flow('digest', async (ctx) => {
      await ctx.slack.post('#eng', 'hi');
      await ctx['linear'].createIssue?.({} as never);
    }));
    // Body use is reported in the generated provider order, not call order.
    expect(flowRequirements(bodyOnly).integrations).toEqual([
      { provider: 'linear', from: 'helper', detail: 'f.linear' },
      { provider: 'slack', from: 'helper', detail: 'f.slack' },
    ]);
  });

  it('reads trigger sources, tools.relayfile, tools.mcp and the deploy target', () => {
    const definition = getFlowDefinition(flow('triage', { tools: { relayfile: ['notion/pages'], mcp: ['filesystem'] } })
      .on(github.issues(), async () => {})
      .on(schedule.every('5m'), async () => {})
      .on(webhook('deploys', { provider: 'aws' }), async () => {}));
    const requirements = flowRequirements(definition, { sources: [{ provider: 'linear' }], repository: { owner: 'a', name: 'b' } });
    expect(requirements.integrations).toEqual([
      { provider: 'notion', from: 'tools', detail: 'tools.relayfile' },
      { provider: 'github', from: 'source', detail: 'on github issues' },
      { provider: 'linear', from: 'source', detail: '--on linear' },
    ]);
    expect(requirements.mcp).toEqual(['filesystem']);
    const target = getFlowDefinition(flow('target', async (f) => { await f.run('true'); }));
    expect(flowRequirements(target, { repository: true }).integrations)
      .toEqual([{ provider: 'github', from: 'source', detail: 'deploy target' }]);
  });

  it('derives harnesses from each worker call, falling back to the project cli then claude', () => {
    const definition = getFlowDefinition(flow('factory', async (f) => {
      await f.agent('review', { task: 'look', cli: 'codex' });
      await f.llm('summarise', { output: {} });
    }));
    expect(flowRequirements(definition).harnessUses).toEqual([
      { harness: 'codex', detail: 'agent "review"' }, { harness: 'claude', detail: 'llm step' },
    ]);
    expect(flowRequirements(definition, { projectCli: '/opt/bin/gemini' }).harnesses).toEqual(['codex', 'gemini']);
    expect(flowRequirements(getFlowDefinition(flow('plain', async (f) => { await f.run('true'); }))).harnesses).toEqual([]);
  });

  it('keeps the same provider once, first declaration wins', () => {
    const definition = getFlowDefinition(flow('digest', { tools: { slack: true } }, async (f) => { await f.slack.post('#a', 'b'); }));
    expect(flowRequirements(definition, { sources: [{ provider: 'slack' }] }).integrations)
      .toEqual([{ provider: 'slack', from: 'tools', detail: 'tools.slack' }]);
  });

  it('reads a compiled spec through its steps and named agents', () => {
    const spec: FlowSpec = { version: '0.1.0', name: 'yaml', cli: 'gemini', agents: { drafter: { cli: 'codex', model: 'gpt-5' } }, steps: [
      { id: 'a', type: 'deterministic', command: 'true' } as never,
      { id: 'b', type: 'agent', instruction: 'x', agent: 'drafter' } as never,
      { id: 'c', type: 'llm', prompt: 'y' } as never,
      { id: 'd', type: 'llm', prompt: 'y', cli: 'claude' } as never,
    ] };
    expect(flowRequirements(spec, { sources: [{ provider: 'github' }] })).toEqual({
      integrations: [{ provider: 'github', from: 'source', detail: '--on github' }],
      harnesses: ['codex', 'gemini', 'claude'],
      harnessUses: [{ harness: 'codex', detail: 'step "b"' }, { harness: 'gemini', detail: 'step "c"' }, { harness: 'claude', detail: 'step "d"' }],
      mcp: [],
    });
  });

  it('maps a cli to a harness by basename only', () => {
    expect(harnessFromCli('claude')).toBe('claude');
    expect(harnessFromCli('C:\\tools\\codex.exe')).toBe('codex');
    expect(harnessFromCli('relayflows-claude')).toBeUndefined();
    expect(harnessFromCli(undefined)).toBeUndefined();
  });

  it('describes requirements the way flows check prints them', () => {
    const definition = getFlowDefinition(flow('digest', { tools: { slack: true, mcp: ['fs'] } }, async (f) => {
      await f.agent('review', { task: 'look', cli: 'claude' });
    }));
    expect(describeFlowRequirements(flowRequirements(definition, { repository: true })))
      .toBe('slack (tools.slack), github (deploy target), claude (agent "review"), mcp fs (tools.mcp)');
    expect(describeFlowRequirements(flowRequirements(getFlowDefinition(flow('plain', async () => {}))))).toBe('');
  });
});

describe('flowRequirements on the shipped examples', () => {
  it('stale-issues needs slack (declared) and claude for its llm step', async () => {
    const requirements = flowRequirements(await example('stale-issues'));
    expect(requirements.integrations).toEqual([{ provider: 'slack', from: 'tools', detail: 'tools.slack' }]);
    expect(requirements.harnessUses).toEqual([{ harness: 'claude', detail: 'llm step' }]);
  });

  it('software-factory needs claude for its named agents and github as a deploy target', async () => {
    const requirements = flowRequirements(await example('software-factory'), { repository: true });
    expect(requirements.integrations).toEqual([{ provider: 'github', from: 'source', detail: 'deploy target' }]);
    expect(requirements.harnesses).toEqual(['claude']);
    expect(requirements.harnessUses[0]?.detail).toMatch(/^agent "/u);
  });

  it('pr-review-pipeline needs github from its --on source', async () => {
    const requirements = flowRequirements(await example('pr-review-pipeline'), { sources: [{ provider: 'github' }] });
    expect(requirements.integrations).toEqual([{ provider: 'github', from: 'source', detail: '--on github' }]);
    expect(requirements.harnesses).toEqual(['claude']);
  });
});
