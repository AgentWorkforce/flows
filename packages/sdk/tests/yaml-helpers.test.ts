import { describe, expect, it, vi } from 'vitest';
import { PreviewTransport } from '@relayfile/relay-helpers';
import { CompileError, compileSpec, compileYaml, compileYamlToCanonicalJson, kernelToAuthoring, toKernelSpec } from '../src/compile.js';
import { helperCall, invokeHelper } from '../src/yaml-helpers.js';
import { preflight } from '../src/preflight.js';
import type { YamlFlowSpec } from '../src/spec.js';

const yaml = `version: 0.1.0
steps:
  - id: notify
    slack:
      post:
        channel: "#test"
        text: hi
`;

function compile(step: unknown) {
  return compileSpec({ version: '0.1.0', steps: [step] });
}

describe('YAML helper expansion', () => {
  it('lowers Slack into an ordinary effect-bearing agent step and round-trips canonically', () => {
    const flow = compileYaml(yaml);
    const step = flow.steps[0]!;
    expect(step).toMatchObject({ id: 'notify', type: 'agent', maxIterations: 1,
      recoveryMode: 'reset', surfaces: { external: ['/slack'] } });
    expect(step).not.toHaveProperty('slack');
    expect(helperCall(step as any)).toEqual({ type: 'effect', provider: 'slack', verb: 'post',
      params: { channel: '#test', text: 'hi' } });
    const kernel = toKernelSpec(flow);
    expect(kernel.steps[0]).not.toHaveProperty('slack');
    expect(toKernelSpec(compileSpec(kernelToAuthoring(kernel)))).toEqual(kernel);
    expect(compileYamlToCanonicalJson(yaml)).toBe(compileYamlToCanonicalJson(yaml.replace('        channel: "#test"\n        text: hi', '        text: hi\n        channel: "#test"')));
  });

  it('preserves identities, dependencies, retries and output verification without mutating input', () => {
    const input: YamlFlowSpec = { version: '0.1.0', steps: [
      { id: 'before', type: 'deterministic', command: 'true' },
      { id: 'notify', dependsOn: ['before'], maxIterations: 3,
        output: { type: 'object', properties: { receipt: { type: 'object' } }, required: ['receipt'] },
        slack: { post: { channel: '#test', text: 'hi' } } },
    ] };
    const snapshot = structuredClone(input);
    const flow = compileSpec(input);
    expect(flow.steps[1]).toMatchObject({ id: 'notify', dependsOn: ['before'], maxIterations: 3,
      verification: { type: 'json_schema', schema: { required: ['receipt'] } } });
    expect(input).toEqual(snapshot);
    expect(compileSpec(flow)).toEqual(flow);
  });

  it.each<Record<string, unknown>>([
    { slack: null }, { slack: [] }, { slack: {} },
    { slack: { post: {}, dm: {} } }, { slack: { unknown: {} } },
    { slack: { constructor: {} } }, { slack: { post: null } },
    { slack: { post: { channel: '#test' } } },
    { slack: { post: { channel: '#test', text: 42 } } },
    { slack: { post: { channel: '#test', text: 'hi', typo: true } } },
    { slack: { post: { channel: '#test', text: 'hi', opts: { typo: 'x' } } } },
    { github: { comment: { target: { owner: 'o', repo: 'r', number: '1' }, body: 'hi' } } },
    { linear: { updateIssue: { issueId: 'ENG-1', args: { typo: 'x' } } } },
    { slack: { dm: { user: 'u', text: 'hi' } }, linear: { comment: { issueId: 'i', body: 'hi' } } },
    { slack: { dm: { user: 'u', text: 'hi' } }, type: 'agent', instruction: 'ignored' },
    { slack: { dm: { user: 'u', text: 'hi' } }, command: 'false' },
    { slack: { dm: { user: 'u', text: 'hi' } }, depends_on: ['missing'] },
    { unknownProvider: { post: {} } },
  ])('rejects invalid helper authoring %j', fields => {
    expect(() => compile({ id: 'invalid', ...fields })).toThrow(CompileError);
  });

  it('still validates dependencies and duplicate ids after expansion', () => {
    expect(() => compile({ id: 'x', dependsOn: ['missing'], slack: { dm: { user: 'u', text: '' } } })).toThrow(/missing/);
    expect(() => compileSpec({ version: '0.1.0', steps: [
      { id: 'x', slack: { dm: { user: 'u', text: '' } } },
      { id: 'x', type: 'deterministic', command: 'true' },
    ] })).toThrow(/duplicate/);
  });

  it.each([
    ['slack', 'post', { channel: '#test', text: 'hi', opts: { replyTo: 'parent' } }, 'messages', { text: 'hi', parentRef: 'parent' }],
    ['slack', 'dm', { user: 'U1', text: 'hi' }, 'direct-messages', { text: 'hi' }],
    ['slack', 'reply', { channel: 'C1', threadTs: '123', text: 'hi' }, 'replies', { text: 'hi' }],
    ['slack', 'react', { channel: 'C1', messageTs: '123', emoji: 'eyes' }, 'reactions', { emoji: 'eyes' }],
    ['github', 'comment', { target: { owner: 'o', repo: 'r', number: 1 }, body: 'hi' }, 'issue-comments', { body: 'hi' }],
    ['github', 'createIssue', { owner: 'o', repo: 'r', title: 'Bug', body: 'hi', labels: ['bug'] }, 'issues', { title: 'Bug', labels: ['bug'] }],
    ['github', 'createPullRequest', { owner: 'o', repo: 'r', title: 'Fix', head: 'fix', base: 'main', draft: true }, 'pull-requests', { title: 'Fix', draft: true }],
    ['github', 'closePullRequest', { owner: 'o', repo: 'r', number: 1 }, 'close-pull-request', {}],
    ['linear', 'comment', { issueId: 'ENG-1', body: 'hi' }, 'comments', { body: 'hi' }],
    ['linear', 'createIssue', { teamId: 'team', title: 'Bug' }, 'issues', { teamId: 'team', title: 'Bug' }],
    ['linear', 'updateIssue', { issueId: 'ENG-1', args: { title: 'Fixed' } }, 'issues', { title: 'Fixed' }],
  ])('dispatches %s.%s through the pinned relay-helper client', async (provider, name, params, resource, body) => {
    const step = compile({ id: 'call', [provider as string]: { [name as string]: params } }).steps[0]!;
    const transport = new PreviewTransport();
    const write = vi.spyOn(transport, 'write');
    await invokeHelper(helperCall(step as any)!, transport);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ provider, resource,
      body: expect.objectContaining(body as object) }));
  });

  it('checks helper mounts without resolving an agent CLI', () => {
    const cli = vi.fn();
    const helper = vi.fn().mockReturnValue(true);
    const probes = { cli, helper, command: () => true, executor: () => true };
    expect(preflight(compileYaml(yaml), { probes })).toMatchObject({ ok: true, resolutions: [] });
    expect(helper).toHaveBeenCalledWith('slack');
    expect(cli).not.toHaveBeenCalled();
    helper.mockReturnValue(false);
    expect(preflight(compileYaml(yaml), { probes })).toMatchObject({ ok: false,
      diagnostics: [expect.objectContaining({ kind: 'helper_mount_required' })] });
    helper.mockImplementation(() => { throw new Error('probe unavailable'); });
    expect(preflight(compileYaml(yaml), { probes })).toMatchObject({ ok: false,
      diagnostics: [expect.objectContaining({ kind: 'probe_failed' })] });
  });
});
