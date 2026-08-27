import { describe, expect, it } from 'vitest';
import { compileYaml } from '../src/compile.js';
import type { AgentStepSpec, DeterministicStepSpec, LlmStepSpec } from '../src/spec.js';

// Ladder rung (b): the same flow plus a bare `llm` step with a verification
// gate (RFC §3 Gate 1 done-when). `llm` is a kernel-level step type distinct
// from `agent`: no workspace, output is a value, verification is the rail.

const DET_PLUS_LLM_YAML = `
version: '0.1.0'
name: deterministic-plus-llm
description: Ladder rung (b) — a deterministic step feeds a verified llm step.
steps:
  - id: prepare
    type: deterministic
    command: "echo 'What is 2+2?'"
    verification:
      type: output_contains
      value: "2+2"
  - id: answer
    type: llm
    dependsOn: [prepare]
    prompt: "Reply with JSON {answer: number} for 2+2."
    model: gpt-4o-mini
    maxIterations: 3
    verification:
      type: json_schema
      schema:
        type: object
        required: [answer]
        properties:
          answer:
            type: number
`;

describe('compile: deterministic + llm flow (ladder rung b)', () => {
  it('compiles a deterministic step and an llm step to spec JSON', () => {
    const spec = compileYaml(DET_PLUS_LLM_YAML);
    expect(spec.steps).toHaveLength(2);

    const prepare = spec.steps[0] as DeterministicStepSpec;
    expect(prepare.type).toBe('deterministic');
    expect(prepare.command).toBe("echo 'What is 2+2?'");

    const answer = spec.steps[1] as LlmStepSpec;
    expect(answer.type).toBe('llm');
    expect(answer.dependsOn).toEqual(['prepare']);
    expect(answer.prompt).toContain('JSON');
    expect(answer.model).toBe('gpt-4o-mini');
    // Semantic retry bound is carried through (kernel DESIGN.md §1.2 max_iterations).
    expect(answer.maxIterations).toBe(3);
  });

  it('keeps the llm step workspace-free and value-output (distinct from agent)', () => {
    const spec = compileYaml(DET_PLUS_LLM_YAML);
    const answer = spec.steps[1] as LlmStepSpec;
    expect(answer.type).toBe('llm');
    expect('surfaces' in answer).toBe(false);
    expect('recoveryMode' in answer).toBe(false);
    expect('instruction' in answer).toBe(false);
  });

  it('carries the json_schema verification gate for structured llm output', () => {
    const spec = compileYaml(DET_PLUS_LLM_YAML);
    const answer = spec.steps[1] as LlmStepSpec;
    expect(answer.verification?.type).toBe('json_schema');
    const schema = answer.verification as { type: string; schema: { type: string; required: string[] } };
    expect(schema.schema.type).toBe('object');
    expect(schema.schema.required).toEqual(['answer']);
  });
});

// Ladder rung (c) is covered structurally here: an `agent` step compiles with
// Appendix A surfaces + recovery mode. The kernel binary + crash harness is
// gate 1's remaining work; the spec surface for it lands now.

const WITH_AGENT_YAML = `
version: '0.1.0'
name: deterministic-llm-agent
steps:
  - id: prep
    type: deterministic
    command: "echo prep"
  - id: think
    type: llm
    dependsOn: [prep]
    prompt: "plan"
  - id: act
    type: agent
    dependsOn: [think]
    instruction: "Edit the repo per the plan."
    recoveryMode: inspect
    maxIterations: 2
    surfaces:
      workspace:
        - surface: repo/
      streams:
        - stream: results
      external:
        - pr://github/example
    permissions:
      accessPreset: readwrite
      fileGlobs: ["src/**"]
`;

describe('compile: agent step (ladder rung c, Appendix A surface)', () => {
  it('compiles surfaces, recovery mode, and permissions', () => {
    const spec = compileYaml(WITH_AGENT_YAML);
    const act = spec.steps[2] as AgentStepSpec;
    expect(act.type).toBe('agent');
    expect(act.instruction).toBe('Edit the repo per the plan.');
    expect(act.recoveryMode).toBe('inspect');
    expect(act.maxIterations).toBe(2);
    expect(act.surfaces?.workspace).toEqual([{ surface: 'repo/' }]);
    expect(act.surfaces?.streams).toEqual([{ stream: 'results' }]);
    expect(act.surfaces?.external).toEqual(['pr://github/example']);
    expect(act.permissions?.accessPreset).toBe('readwrite');
    expect(act.permissions?.fileGlobs).toEqual(['src/**']);
  });

  it('defaults agent recoveryMode to reset when omitted (Appendix A rule 4)', () => {
    const spec = compileYaml(`
version: '0.1.0'
name: agent-default-recovery
steps:
  - id: act
    type: agent
    instruction: "do something"
`);
    const act = spec.steps[0] as AgentStepSpec;
    expect(act.recoveryMode).toBe('reset');
  });
});
