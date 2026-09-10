import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { flow } from '@relayflows/surface';
import { executeAuthoredFlow, AuthoredFlowExecutionError } from '../src/authored-flow-executor.js';
import { attachLocalAgent } from '../src/local-agent.js';
import { LlmWorker } from '../src/llm-worker.js';
import { JournalClient } from '../src/journal-client.js';
import { socketPathFor } from '../src/daemon-connection.js';
import { compileSpec, compileYaml, toKernelSpec } from '../src/compile.js';
import { checkAuthoredFlow } from '../src/cli/check.js';
import { classifyOutcome } from '../src/cli/run.js';
import { chainFixture, shellWord } from './flow-chain-fixture.js';

const schema = { type: 'object', required: ['message'], properties: { message: { type: 'string' } } };
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

async function setup(output?: string) {
  const fixture = chainFixture(output);
  closes.push(() => fixture.close());
  const client = await fixture.connect();
  const agent = await attachLocalAgent(client);
  closes.push(() => agent.close());
  const llmClient = new JournalClient(socketPathFor(fixture.data));
  await llmClient.connect();
  await llmClient.hello('chain-llm-worker');
  closes.push(async () => { llmClient.close(); });
  const llm = new LlmWorker(llmClient, `${agent.stream}-llm`);
  const failures: unknown[] = [];
  llm.on('error', error => failures.push(error));
  await llm.attach();
  closes.push(() => llm.close());
  return { fixture, client, agent, failures };
}

describe('flow executor LLM and output-binding chain', () => {
  it('runs f.llm -> f.agent -> f.run with schema-verified journal output and the exact allowed model', async () => {
    const { fixture, client, agent, failures } = await setup();
    const artifact = join(fixture.root, 'result.json');
    const handle = flow('flagship-chain', async f => {
      const value = await f.llm('EXTRACT the message', { output: schema, model: 'test-model' });
      expect(value).toEqual({ message: 'hello from llm' });
      const drafted = await f.agent('draft', { task: `Draft from ${JSON.stringify(value)}` });
      await f.run(`printf '%s' ${shellWord(drafted.summary)} > ${shellWord(artifact)}`);
      f.done('success');
    });
    const result = await executeAuthoredFlow(handle, client, undefined, { flowPath: fixture.flowPath, localAgentStream: agent.stream });
    expect(result.completionReason).toBe('success');
    expect(result.journalSteps.map(step => step.id)).toEqual(['llm-1', 'agent-2', 'run-3', 'complete-4']);
    expect(JSON.parse(readFileSync(artifact, 'utf8'))).toEqual({ message: 'hello from llm' });
    const requests = fixture.requests();
    expect(requests[0].model).toBe('test-model');
    expect(JSON.parse(requests[0].instruction.split('\n').at(-1))).toEqual(schema);
    expect(requests[1].instruction).toBe('Draft from {"message":"hello from llm"}');
    const entries = (await client.journalRead(result.journalSteps[0]!.runId, 1)).entries;
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({
      entry_type: 'step.completed', payload: expect.objectContaining({ completionReason: 'success', output: { message: 'hello from llm' } }),
    })]));
    expect(failures).toEqual([]);
  });

  it.each(['not JSON', '{"message":7}'])('fails invalid LLM output before the next step: %s', async output => {
    const { fixture, client, agent, failures } = await setup(output);
    const marker = join(fixture.root, 'must-not-exist');
    const handle = flow('invalid-output', async f => {
      await f.llm('EXTRACT', { output: schema });
      await f.run(`touch ${shellWord(marker)}`);
      f.done('success');
    });
    let caught: unknown;
    try { await executeAuthoredFlow(handle, client, undefined, { flowPath: fixture.flowPath, localAgentStream: agent.stream }); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AuthoredFlowExecutionError);
    const entries = (await client.journalRead((caught as AuthoredFlowExecutionError).runId!, 1)).entries;
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({
      entry_type: 'step.completed', payload: expect.objectContaining({ completionReason: 'verification_failed' }),
    })]));
    expect(existsSync(marker)).toBe(false);
    expect(fixture.requests()).toHaveLength(1);
    expect(failures).toEqual([]);
  });

  it('retains tagged-template text output', async () => {
    const { fixture, client } = await setup('plain response');
    await executeAuthoredFlow(flow('text-llm', async f => {
      expect(await f.llm`Say ${'hello'}`).toBe('plain response');
      f.done('success');
    }), client, undefined, { flowPath: fixture.flowPath });
    expect(fixture.requests()[0].instruction).toBe('Say hello');
  });

  it.each([
    ['null', { type: 'null' }, null],
    ['[1,2]', { type: 'array', items: { type: 'number' } }, [1, 2]],
    ['"hello"', { type: 'string' }, 'hello'],
  ])('preserves JSON values without promoting them to process wrappers: %s', async (stdout, output, expected) => {
    const { fixture, client } = await setup(stdout);
    await executeAuthoredFlow(flow('json-value', async f => {
      expect(await f.llm('EXTRACT', { output })).toEqual(expected);
      f.done('success');
    }), client, undefined, { flowPath: fixture.flowPath });
  });

  it('refuses a model outside flows.json before a run or adapter execution', async () => {
    const { fixture, client } = await setup();
    await expect(executeAuthoredFlow(flow('bad-model', async f => {
      await f.llm('EXTRACT', { output: schema, model: 'unapproved' });
      f.done('success');
    }), client, undefined, { flowPath: fixture.flowPath })).rejects.toMatchObject({ code: 'llm_cli_unresolved' });
    expect(existsSync(fixture.calls)).toBe(false);
  });

  it('runs the authored LLM path through the built flows CLI', async () => {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    await fixture.connect();
    writeFileSync(fixture.flowPath, `import { flow } from '@relayflows/surface';
export default flow('cli-llm', async f => {
  const value = await f.llm('EXTRACT', { output: ${JSON.stringify(schema)} });
  if (JSON.stringify(value) !== '{"message":"hello from llm"}') throw new Error('wrong output');
  f.done('success');
});`);
    const result = fixture.invoke('run', fixture.flowPath, '--input', '{}', '--local-agent', '--data-dir', fixture.data, '--json');
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ completionReason: 'success', completedSteps: 2 });
  });

  it('passes a declarative verified value through an agent into a deterministic artifact', async () => {
    const payload = { message: "quotes '\"\n$(touch forbidden) `echo hi`; \\ end" };
    const { fixture, client, agent } = await setup(JSON.stringify(payload));
    const artifact = join(fixture.root, 'binding.json');
    const spec = compileSpec({ version: '0.1.0', steps: [
      { id: 'extract', type: 'llm', prompt: 'EXTRACT', output: schema },
      { id: 'draft', type: 'agent', instruction: 'Draft from input.', output: schema,
        surfaces: { streams: [{ stream: agent.stream }] }, input: { message: { step: 'extract', path: ['message'] } } },
      { id: 'write', type: 'deterministic', input: { message: { step: 'draft', path: ['message'] }, whole: { step: 'extract' } },
        command: `printf '%s' "$FLOWS_INPUT" > ${shellWord(artifact)}` },
    ] });
    const checked = checkAuthoredFlow(spec, fixture.flowPath);
    expect(checked.report.ok, JSON.stringify(checked.report)).toBe(true);
    const outcome = await client.runStart(toKernelSpec(checked.flow!));
    const completed = await classifyOutcome(client, 'run', outcome, checked.report, '', {});
    expect(completed.exitCode, JSON.stringify(completed.report)).toBe(0);
    expect(JSON.parse(readFileSync(artifact, 'utf8'))).toEqual({ message: payload.message, whole: payload });
    expect(fixture.requests()[1].instruction).toBe(`Draft from input.\n\ninput:\n${JSON.stringify(payload)}`);
    expect(existsSync(join(fixture.root, 'forbidden'))).toBe(false);
  });

  it('journals a missing optional field as a failure before the consuming command executes', async () => {
    const { fixture, client } = await setup('{}');
    const marker = join(fixture.root, 'must-not-run');
    const checked = checkAuthoredFlow(compileSpec({ version: '0.1.0', steps: [
      { id: 'extract', type: 'llm', prompt: 'EXTRACT', output: { ...schema, required: [] } },
      { id: 'write', type: 'deterministic', input: { message: { step: 'extract', path: ['message'] } }, command: `touch ${shellWord(marker)}` },
    ] }), fixture.flowPath);
    expect(checked.report.ok).toBe(true);
    const outcome = await client.runStart(toKernelSpec(checked.flow!));
    const completed = await classifyOutcome(client, 'run', outcome, checked.report, '', {});
    expect(completed.exitCode).toBe(1);
    expect(existsSync(marker)).toBe(false);
    const entries = (await client.journalRead(outcome.run_id, 1)).entries;
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({
      entry_type: 'step.completed', step_id: 'write', payload: expect.objectContaining({ completionReason: 'worker_error' }),
    })]));
  });

  it('flows run consumes YAML bindings and resume reuses the original journal output', async () => {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    const marker = join(fixture.root, 'source-count');
    const artifact = join(fixture.root, 'resumed-input.json');
    const yaml = `version: '0.1.0'
steps:
  - id: source
    type: deterministic
    command: ${JSON.stringify(`printf x >> ${shellWord(marker)}; printf original`)}
    verification:
      type: json_schema
      schema:
        type: object
        properties:
          stdout_tail: { type: string }
  - id: write
    type: deterministic
    input:
      message: { step: source, path: [stdout_tail] }
    command: ${JSON.stringify(`printf '%s' "$FLOWS_INPUT" > ${shellWord(artifact)}`)}
`;
    const compiled = toKernelSpec(compileYaml(yaml));
    const specPath = join(fixture.root, 'spec.json');
    writeFileSync(specPath, JSON.stringify(compiled));
    const first = spawnSync(fixture.binary, ['--data-dir', fixture.data, 'run', specPath, '--stop-after', '1'], { encoding: 'utf8' });
    expect(first.status, first.stderr).toBe(0);
    expect(existsSync(artifact)).toBe(false);
    const runId = JSON.parse(first.stdout).run_id;
    // Change the source on disk; resume must use run.spawned + step.completed.
    writeFileSync(specPath, '{}');
    const resumed = fixture.invoke('resume', runId, '--data-dir', fixture.data, '--json');
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(JSON.parse(readFileSync(artifact, 'utf8'))).toEqual({ message: 'original' });
    expect(readFileSync(marker, 'utf8')).toBe('x');
    // Also exercise the actual YAML entry point with a separate data dir.
    const yamlPath = join(fixture.root, 'binding.yaml');
    writeFileSync(yamlPath, yaml);
    const cli = fixture.invoke('run', yamlPath, '--data-dir', fixture.data, '--json');
    expect(cli.status, cli.stderr).toBe(0);
    expect(JSON.parse(readFileSync(artifact, 'utf8'))).toEqual({ message: 'original' });
  });
});
