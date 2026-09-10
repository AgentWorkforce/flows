import { describe, expect, it } from 'vitest';
import { compileSpec, compileYaml, kernelToAuthoring, toKernelSpec } from '../src/compile.js';
import type { FlowSpec } from '../src/spec.js';
import { preflight } from '../src/preflight.js';
import { workerInstruction } from '../src/worker-input.js';
import type { StepDispatchEvent } from '../src/protocol.js';

const schema = {
  type: 'object', required: ['message', 'items'],
  properties: { message: { type: 'string' }, items: { type: 'array', items: { type: 'number' } } },
};
const source = { id: 'extract', type: 'llm' as const, prompt: 'extract', output: schema };
const consumer = { id: 'write', type: 'deterministic', command: 'printenv FLOWS_INPUT', input: { message: { step: 'extract', path: ['message'] } } };

describe('declarative output binding', () => {
  it('compiles YAML selectors into durable input and implicit dependency edges', () => {
    const compiled = compileYaml(`version: '0.1.0'
steps:
  - id: extract
    type: agent
    instruction: Return JSON.
    output:
      type: object
      properties:
        message: { type: string }
  - id: write
    type: deterministic
    input:
      message: { step: extract, path: [message] }
      whole: { step: extract }
    command: printenv FLOWS_INPUT
`);
    expect(compiled.steps[1]?.dependsOn).toEqual(['extract']);
    const kernel = toKernelSpec(compiled);
    expect(kernel.steps[1]).toMatchObject({ input: {
      message: { step: 'extract', path: ['message'] }, whole: { step: 'extract' },
    }, depends_on: ['extract'] });
    expect(toKernelSpec(compileSpec(kernelToAuthoring(kernel)))).toEqual(kernel);
  });

  it('deduplicates explicit and implied edges and selects typed array items', () => {
    const compiled = compileSpec({ version: '0.1.0', steps: [source, {
      ...consumer, dependsOn: ['extract'], input: { number: { step: 'extract', path: ['items', 0] } },
    }] });
    expect(toKernelSpec(compiled).steps[1]?.depends_on).toEqual(['extract']);
  });

  it('preserves existing serialized dependency lists when input is absent', () => {
    const compiled = compileSpec({ version: '0.1.0', steps: [source, {
      ...consumer, input: undefined, dependsOn: ['extract', 'extract'],
    }] });
    expect(compiled.steps[1]?.dependsOn).toEqual(['extract', 'extract']);
    expect(toKernelSpec(compiled).steps[1]?.depends_on).toEqual(['extract', 'extract']);
    expect(toKernelSpec(compiled).steps[1]).not.toHaveProperty('input');
  });

  it.each([
    [{ message: { step: 'missing' } }, 'unknown source'],
    [{ message: { step: 'extract', path: ['absent'] } }, 'not present'],
    [{ message: { step: 'extract', path: ['items', -1] } }, 'expected { step'],
    [{ message: { step: 'extract', path: null } }, 'expected { step'],
    [{ message: { step: 'extract', typo: [] } }, 'expected { step'],
    [{ message: '${{ steps.extract.output.message }}' }, 'expected { step'],
    [null, 'expected a map'],
  ])('refuses invalid bindings before preflight probes: %j', (input, message) => {
    let probed = false;
    const report = preflight({ version: '0.1.0', steps: [source, { ...consumer, input }] } as unknown as FlowSpec, {
      probes: { cli: () => { probed = true; return { exists: true, authenticated: true }; }, executor: () => true, command: () => true },
    });
    expect(report.ok).toBe(false);
    expect(report.diagnostics.some(d => d.message.includes(message))).toBe(true);
    expect(probed).toBe(false);
  });

  it('refuses forward references, missing source schemas, and cycles introduced by bindings', () => {
    expect(() => compileSpec({ version: '0.1.0', steps: [consumer, source] })).toThrow('forward');
    expect(() => compileSpec({ version: '0.1.0', steps: [{ ...source, output: undefined }, consumer] })).toThrow('must declare an output schema');
    expect(() => compileSpec({ version: '0.1.0', steps: [{ ...source, dependsOn: ['write'] }, consumer] })).toThrow('cycle');
  });

  it('appends JSON input after authored instructions and memory without interpreting it', () => {
    const input = { message: "quoted '\"\n$(touch forbidden); `echo nope`", value: null, count: 3 };
    const dispatch = { spec: { input: consumer.input }, input, memory: { pack: 'memory' } } as unknown as StepDispatchEvent;
    const prompt = workerInstruction('Task', dispatch);
    expect(prompt).toBe(`Task\n\nMemory context (journaled):\n"memory"\n\ninput:\n${JSON.stringify(input)}`);
    expect(() => workerInstruction('Task', { spec: { input: consumer.input } } as StepDispatchEvent)).toThrow('did not resolve');
  });
});
