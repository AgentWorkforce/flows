import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { flow } from '@relayflows/surface';
import { agentResumeDeclarationError, agentResumeTransportError } from '../src/agent-resume.js';
import { buildTranscriptDigest } from '../src/agent-transcript.js';
import { claudeAdapter } from '../src/adapters/claude.js';
import { codexAdapter } from '../src/adapters/codex.js';
import { agentResumable } from '../src/cli-adapter.js';
import { compileYaml, toKernelSpec } from '../src/compile.js';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { kernelToAuthoring, validateSpec } from '../src/index.js';
import { JournalClient } from '../src/journal-client.js';
import { runAgentCli } from '../src/worker-cli.js';
import { sendOk, sendResult, sockPath, startLoopback } from './journal-client-loopback.js';

const SESSION = '1908508f-989e-4159-82b0-6a676c3d74d3';
const cases: Array<{ name: string; resume: string; valid: boolean }> =
  JSON.parse(readFileSync(new URL('../../../testdata/agent-resume-cases.json', import.meta.url), 'utf8'));

describe('the resume declaration rule is the kernel rule', () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(agentResumeDeclarationError(testCase.resume) === undefined).toBe(testCase.valid);
    });
  }

  it('refuses a non-string and refuses resume over the relay transport', () => {
    expect(agentResumeDeclarationError(7)).toMatch(/session id/);
    expect(agentResumeTransportError(SESSION, 'relay')).toMatch(/relay/);
    expect(agentResumeTransportError(SESSION, 'direct')).toBeUndefined();
  });
});

describe('declarative resume', () => {
  const agent = (extra: Record<string, unknown>) => ({ version: '0.1.0', steps: [{ id: 'a', type: 'agent', instruction: 'x', ...extra }] });

  it('is accepted as a session id and refused otherwise, or over relay', () => {
    expect(validateSpec(agent({ resume: SESSION })).ok).toBe(true);
    expect(validateSpec(agent({ resume: '--dangerously-skip-permissions' })).errors.join(' ')).toContain('steps[0].resume');
    expect(validateSpec(agent({ resume: SESSION, transport: 'relay' })).errors.join(' ')).toContain('resume is not supported with transport "relay"');
  });

  it('round-trips through the kernel dialect', () => {
    const authored = compileYaml(`version: '0.1.0'\nsteps:\n  - id: a\n    type: agent\n    instruction: x\n    resume: ${SESSION}\n`);
    expect(toKernelSpec(authored).steps[0]).toMatchObject({ resume: SESSION });
    expect(kernelToAuthoring(toKernelSpec(authored))).toEqual(authored);
  });
});

describe('the adapters continue a recorded session', () => {
  it('claude passes --resume before the task operand, and nothing when not resuming', () => {
    const args = claudeAdapter.buildAgentInvocation('fix it', 'm', SESSION).args;
    expect(args.slice(0, 3)).toEqual(['-p', '--resume', SESSION]);
    expect(args.slice(-2)).toEqual(['--', 'fix it']);
    expect(claudeAdapter.buildAgentInvocation('fix it', 'm').args).not.toContain('--resume');
  });

  it('codex runs exec resume with the same flags and the thread id before the task operand', () => {
    const args = codexAdapter.buildAgentInvocation('fix it', 'm', SESSION).args;
    expect(args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args.slice(-3)).toEqual([SESSION, '--', 'fix it']);
    expect(codexAdapter.buildAgentInvocation('fix it', 'm').args[1]).toBe('--skip-git-repo-check');
  });

  it('only claude and codex can resume', () => {
    expect(agentResumable('claude')).toBe(true);
    expect(agentResumable('codex')).toBe(true);
    expect(agentResumable('relayflows-wrapper-v1')).toBe(false);
  });

  it('a step asking another CLI, or the relay, to resume is refused rather than run cold', async () => {
    for (const [cli, transport] of [['./custom-wrapper', 'direct'], ['claude', 'relay']] as const) {
      const result = await runAgentCli(cli, 'fix it', undefined, 'm', undefined, undefined, 'agent', undefined, undefined,
        transport, undefined, process.env, undefined, undefined, SESSION);
      expect(result.exit_code).toBeNull();
      expect(result.stderr_tail).toMatch(/resume is refused/);
    }
  });
});

describe('the session a CLI ran as is recorded', () => {
  it('codex: the thread.started id is the session id', () => {
    const digest = buildTranscriptDigest([
      { type: 'thread.started', thread_id: SESSION },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ], 'codex', { exit_code: 0, stdout_tail: '', stderr_tail: '' }, {});
    expect(digest.result).toMatchObject({ provider: 'codex', session_id: SESSION });
  });
});

function setupProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-resume-'));
  const wrapper = join(root, 'adapter.mjs');
  writeFileSync(wrapper, `#!/usr/bin/env node
import { receiveWrapperRequest } from ${JSON.stringify(resolve('../../testdata/preflight/wrapper-session.mjs'))};
if (process.argv[2] === 'auth') process.exit(0);
await receiveWrapperRequest();
process.stdout.write('unused');
`);
  chmodSync(wrapper, 0o755);
  writeFileSync(join(root, 'flows.json'), JSON.stringify({ cli: wrapper, models: ['test-model'] }));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
  return root;
}

/** A fake kernel journaling what a worker journals: output plus the transcript evidence. */
function startServer(sock: string, seen: Array<Record<string, unknown>>, output: Record<string, unknown>, sessionId: string): Server {
  let nextRun = 1;
  const stepByRun = new Map<string, { id: string; type: string }>();
  return startLoopback(sock, {
    hello: ctx => sendOk(ctx),
    'run.start': (ctx, params) => {
      const step = ((params.spec as Record<string, unknown>)['steps'] as Record<string, unknown>[])[0]!;
      seen.push(step);
      const runId = `agent-resume-run-${nextRun++}`;
      stepByRun.set(runId, { id: step['id'] as string, type: step['type'] as string });
      sendResult(ctx, { run_id: runId, status: 'completed', completion_reason: 'success', completed_steps: 1 });
    },
    'journal.read': (ctx, params) => {
      const step = stepByRun.get(params.run_id as string)!;
      sendResult(ctx, { entries: [{
        entry_type: 'step.completed', step_id: step.id,
        payload: {
          completionReason: 'success', disposition: 'step_done',
          output: step.type === 'agent' ? output : { exit_code: 0, stdout_tail: '', stderr_tail: '' },
          ...(step.type === 'agent' ? { trajectory_tail: { transcript: { result: { provider: 'claude', session_id: sessionId } } } } : {}),
        },
      }] });
    },
  });
}

describe('f.agent resume and sessionId', () => {
  let server: Server | undefined;
  let path: string | undefined;
  let root: string | undefined;
  afterEach(async () => {
    if (server !== undefined) await new Promise<void>(done => server!.close(() => done()));
    if (path !== undefined) rmSync(path, { force: true });
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    server = undefined; path = undefined; root = undefined;
  });

  async function drive(output: Record<string, unknown>, sessionId: string, body: Parameters<typeof flow>[1]) {
    root = setupProject();
    path = sockPath();
    const seen: Array<Record<string, unknown>> = [];
    server = startServer(path, seen, output, sessionId);
    const client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello('agent-resume-test');
    try {
      const result = await executeAuthoredFlow(flow('resume-test', body as never), client, undefined, {
        flowPath: join(root, 'resume-test.flow.ts'), localAgentStream: 'test-stream',
      });
      return { result, seen };
    } finally {
      client.close();
    }
  }

  it('carries resume into the kernel spec and reports the session the step ran as', async () => {
    let reported: unknown;
    const { result, seen } = await drive({ exit_code: 0, stdout_tail: 'done', stderr_tail: '' }, SESSION, async (f) => {
      reported = (await f.agent('fix', { task: 'fix it', resume: SESSION })).sessionId;
      f.done('success');
    });
    expect(result.completionReason).toBe('success');
    expect(seen.find(step => step['type'] === 'agent')).toMatchObject({ resume: SESSION });
    expect(reported).toBe(SESSION);
  });

  it('reports the session for an agent that answered with a JSON object too', async () => {
    let reported: unknown;
    await drive({ summary: 's', replies: [] }, SESSION, async (f) => {
      reported = (await f.agent('fix', { task: 'fix it' })).sessionId;
      f.done('success');
    });
    expect(reported).toBe(SESSION);
  });

  it('never offers a truncated label as a session id', async () => {
    let reported: unknown = 'unset';
    await drive({ exit_code: 0, stdout_tail: 'done', stderr_tail: '' }, `${'a'.repeat(240)}…[16 bytes truncated]`, async (f) => {
      reported = (await f.agent('fix', { task: 'fix it' })).sessionId;
      f.done('success');
    });
    expect(reported).toBeUndefined();
  });

  it('refuses an invalid resume before anything runs', async () => {
    await expect(drive({ exit_code: 0, stdout_tail: '', stderr_tail: '' }, SESSION, async (f) => {
      await f.agent('fix', { task: 'fix it', resume: '--yolo' });
    })).rejects.toThrow(/options\.resume: expected a CLI session id/);
  });
});
