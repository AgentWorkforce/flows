import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFlow } from '../src/create-flow.js';
import { observeStep, renderProgress, type ProgressEvent } from '../src/progress.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function target() {
  const root = await mkdtemp(join(tmpdir(), 'flows-scaffold-'));
  roots.push(root);
  return join(root, 'hello');
}

describe('SDK project scaffolder', () => {
  it('emits an agent starter, local-worker command and the chosen CLI', async () => {
    const directory = await target();
    const result = await createFlow(directory, { install: false, cli: 'codex' });
    expect(result.installed).toBe(false);
    expect(JSON.parse(await readFile(result.configPath, 'utf8'))).toEqual({ cli: 'codex' });
    expect(await readFile(result.flowPath, 'utf8')).toContain("await f.agent('greeter'");
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    expect(manifest.scripts.start).toBe("flows run hello.flow.ts --local-agent --input '{}'");
    expect(manifest.dependencies.relayflows).toBe(manifest.dependencies['@relayflows/surface']);
  });
  it('offers a credential-free deterministic starter', async () => {
    const result = await createFlow(await target(), { install: false, template: 'deterministic' });
    expect(await readFile(result.flowPath, 'utf8')).not.toContain('f.agent');
    expect(await readFile(join(result.directory, 'package.json'), 'utf8')).not.toContain('--local-agent');
  });
  it('refuses an existing project without changing any files', async () => {
    const directory = await target();
    await createFlow(directory, { install: false });
    const sentinel = join(directory, 'flows.json');
    await writeFile(sentinel, 'keep me');
    await expect(createFlow(directory, { install: false })).rejects.toThrow('already exists');
    expect(await readFile(sentinel, 'utf8')).toBe('keep me');
  });
  it('validates names and template before writing', async () => {
    const directory = await target();
    await expect(createFlow(directory, { name: '../escape', install: false })).rejects.toThrow('Flow name');
    await expect(createFlow(directory, { template: 'unknown' as 'agent', install: false })).rejects.toThrow('Template');
    expect(await readdir(roots.at(-1)!)).toEqual([]);
  });
});

describe('progress is an observation of execution', () => {
  it('does not report completion before the journal operation resolves', async () => {
    const events: ProgressEvent[] = [];
    let finish!: () => void;
    const journalWrite = new Promise<void>(resolve => { finish = resolve; });
    const observed = observeStep('greet', 'agent', () => journalWrite, event => events.push(event));
    expect(events.map(event => event.type)).toEqual(['step.started']);
    finish();
    await observed;
    expect(events.map(event => event.type)).toEqual(['step.started', 'step.completed']);
    expect(renderProgress(events).join('\n')).toContain('[agent: completed]');
  });
  it('propagates a journal failure without inventing a successful completion', async () => {
    const events: ProgressEvent[] = [];
    const failure = new Error('journal_write_failed');
    await expect(observeStep('write', 'deterministic', async () => { throw failure; }, event => events.push(event)))
      .rejects.toBe(failure);
    expect(events.map(event => event.type)).toEqual(['step.started', 'step.failed']);
    expect(events.at(-1)?.completionReason).toBeUndefined();
  });
  it('renders time and strips terminal controls from step names', () => {
    expect(renderProgress([{ type: 'step.running', stepId: '\x1b[2Jagent', stepType: 'agent', elapsedMs: 1234 }]))
      .toEqual(['↻ ?[2Jagent (agent) [agent: running] 1.23s']);
  });
});
