import { describe, expect, it } from 'vitest';
import { CompileError, compileSpec, compileYaml, toKernelSpec } from '../src/compile.js';
import type { AgentStepSpec } from '../src/spec.js';

describe('named agent declarations', () => {
  it('lowers a selected agent CLI and model into the existing agent step', () => {
    const flow = compileYaml(`
version: '0.1.0'
agents:
  reviewer:
    cli: claude
    model: claude-sonnet-4-6
steps:
  - id: review
    type: agent
    agent: reviewer
    instruction: Review the change.
`);

    expect(flow).not.toHaveProperty('agents');
    expect(flow.steps[0] as AgentStepSpec).toMatchObject({
      id: 'review',
      type: 'agent',
      cli: 'claude',
      model: 'claude-sonnet-4-6',
    });
    expect(toKernelSpec(flow).steps[0]).toMatchObject({
      type: 'agent',
      cli: 'claude',
      model: 'claude-sonnet-4-6',
    });
  });

  it('applies independent precedence: step override > named agent > flow CLI', () => {
    const flow = compileYaml(`
version: '0.1.0'
cli: flow-cli
agents:
  reviewer:
    cli: named-cli
    model: named-model
steps:
  - id: named
    type: agent
    agent: reviewer
    instruction: Named values.
  - id: cli-override
    type: agent
    agent: reviewer
    cli: step-cli
    instruction: Override only CLI.
  - id: model-override
    type: agent
    agent: reviewer
    model: step-model
    instruction: Override only model.
  - id: anonymous
    type: agent
    instruction: Preserve existing anonymous resolution.
`);

    expect(flow.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'named', cli: 'named-cli', model: 'named-model' }),
      expect.objectContaining({ id: 'cli-override', cli: 'step-cli', model: 'named-model' }),
      expect.objectContaining({ id: 'model-override', cli: 'named-cli', model: 'step-model' }),
    ]));
    expect(flow.steps.find((step) => step.id === 'anonymous')).not.toHaveProperty('cli');
    expect(flow.steps.find((step) => step.id === 'anonymous')).not.toHaveProperty('model');
    expect(flow.cli).toBe('flow-cli');
  });

  it('lowers a raw typed FlowSpec passed directly to the kernel mapper', () => {
    const kernel = toKernelSpec({
      version: '0.1.0',
      agents: { reviewer: { cli: 'claude', model: 'declared-model' } },
      steps: [{
        id: 'review',
        type: 'agent',
        agent: 'reviewer',
        instruction: 'Review.',
      }],
    });

    expect(kernel).not.toHaveProperty('agents');
    expect(kernel.steps[0]).toMatchObject({ cli: 'claude', model: 'declared-model' });
  });

  it('refuses an unknown named agent at the authoring boundary', () => {
    expect(() => compileYaml(`
version: '0.1.0'
agents:
  reviewer: { cli: claude, model: declared-model }
steps:
  - id: review
    type: agent
    agent: reviwer
    instruction: Review.
`)).toThrow('spec.steps[0].agent: unknown named agent "reviwer"');
  });

  it.each([
    ['', 'expected a non-empty string'],
    [' declared-model', 'expected a trimmed string'],
    ['declared-model ', 'expected a trimmed string'],
    ['declared\\tmodel', 'must not contain control characters'],
  ])('refuses malformed model %j with an author-facing field error', (model, expected) => {
    const value = model === 'declared\\tmodel' ? 'declared\tmodel' : model;
    expect(() => compileSpec({
      version: '0.1.0',
      steps: [{ id: 'review', type: 'agent', instruction: 'Review.', model: value }],
    })).toThrow(`spec.steps[0].model: ${expected}`);
  });

  it('requires both CLI and model on every named declaration', () => {
    expect(() => compileSpec({
      version: '0.1.0',
      agents: { reviewer: { cli: 'claude' } },
      steps: [{ id: 'review', type: 'agent', agent: 'reviewer', instruction: 'Review.' }],
    })).toThrow('spec.agents.reviewer.model: expected a non-empty string');
  });

  it('refuses a model typo inside a named declaration instead of dropping it', () => {
    expect(() => compileYaml(`
version: '0.1.0'
agents:
  reviewer:
    cli: claude
    modle: claude-sonnet-4-6
steps:
  - id: review
    type: agent
    agent: reviewer
    instruction: Review the change.
`)).toThrow(CompileError);

    try {
      compileYaml(`
version: '0.1.0'
agents:
  reviewer:
    cli: claude
    modle: claude-sonnet-4-6
steps:
  - id: review
    type: agent
    agent: reviewer
    instruction: Review the change.
`);
    } catch (error) {
      expect((error as CompileError).errors.join('\n')).toContain(
        'spec.agents.reviewer: unknown key "modle" — did you mean "model"?',
      );
    }
  });
});
