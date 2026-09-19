import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preflight } from '../src/preflight.js';
import { compileSpec, kernelToAuthoring, toKernelSpec } from '../src/compile.js';
import { checkAuthoredFlow } from '../src/cli/check.js';
import { runCli, type CheckReport, type CliIo } from '../src/cli.js';

const UNENFORCED = 'permissions_unenforced';
const NOT_ENFORCED = 'not currently enforced (gate 8 / #442)';
const READONLY_SENTENCE = "accessPreset: 'readonly' does not prevent writes.";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const options = () => ({ probes: {
  cli: vi.fn(() => ({ exists: true, authenticated: true, modelAvailable: true })),
  executor: vi.fn(() => true),
  command: vi.fn(() => true),
} });

const agentFlow = (permissions: unknown, id = 'review'): unknown => ({
  version: '0.1.0',
  steps: [{ id, type: 'agent', cli: 'claude', instruction: 'Review.', permissions }],
});

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }, stdout, stderr };
}

/** A project boundary, so a stray /tmp/flows.json cannot steer the check. */
function temporaryProject(prefix = 'flows-permissions-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, 'flows.json'), JSON.stringify({ executors: [] }));
  const cli = join(directory, 'agent-cli');
  writeFileSync(cli, `#!/bin/sh
if [ "\${1-}" = "--relayflows-adapter-v1" ]; then
  printf '%s\\n' 'relayflows-agent-cli-v1'
  exit 0
fi
test "$1" = "auth" && test "$2" = "status"
`);
  chmodSync(cli, 0o755);
  return directory;
}

describe('permissions are declared, recorded, and not enforced — preflight says so', () => {
  it.each([
    ['an empty declaration', {}, '', false],
    ['fileGlobs alone', { fileGlobs: ['src/**'] }, ' (fileGlobs)', false],
    ['networkAllowlist alone', { networkAllowlist: ['api.example.com'] }, ' (networkAllowlist)', false],
    ['accessPreset readwrite alone', { accessPreset: 'readwrite' }, ' (accessPreset)', false],
    ['accessPreset readonly alone', { accessPreset: 'readonly' }, ' (accessPreset)', true],
    ['empty arrays', { fileGlobs: [], networkAllowlist: [] }, ' (fileGlobs, networkAllowlist)', false],
    ['every field together', {
      networkAllowlist: ['api.example.com'], accessPreset: 'readonly', fileGlobs: ['src/**'],
    }, ' (fileGlobs, networkAllowlist, accessPreset)', true],
  ] as const)('warns once on %s', (_label, permissions, fields, readonly) => {
    const result = preflight(agentFlow(permissions), options());
    expect(result.ok).toBe(true);
    const warnings = result.diagnostics.filter((d) => d.kind === UNENFORCED);
    expect(warnings).toEqual([{
      severity: 'warning',
      kind: UNENFORCED,
      stepId: 'review',
      message: expect.stringContaining(`Step "review" declares permissions${fields}.`),
    }]);
    // Declared field names, never their values: a glob or host adds length
    // without adding anything an author does not already have in front of them.
    expect(warnings[0]!.message).toContain(NOT_ENFORCED);
    expect(warnings[0]!.message).not.toContain('src/**');
    expect(warnings[0]!.message).not.toContain('api.example.com');
    expect(warnings[0]!.message.includes(READONLY_SENTENCE)).toBe(readonly);
  });

  it('warns per declaring step and stays silent on an undeclared agent', () => {
    const result = preflight({
      version: '0.1.0',
      cli: 'claude',
      steps: [
        { id: 'read', type: 'agent', instruction: 'Read.', permissions: { accessPreset: 'readonly' } },
        { id: 'write', type: 'agent', instruction: 'Write.', permissions: { fileGlobs: ['evidence/**'] } },
        { id: 'free', type: 'agent', instruction: 'Anything.' },
      ],
    }, options());
    expect(result.ok).toBe(true);
    expect(result.diagnostics.filter((d) => d.kind === UNENFORCED).map((d) => d.stepId)).toEqual(['read', 'write']);
  });

  it('stays silent for deterministic and llm steps, which cannot declare permissions', () => {
    const result = preflight({
      version: '0.1.0',
      cli: 'claude',
      steps: [
        { id: 'build', type: 'deterministic', command: 'printf ok' },
        { id: 'ask', type: 'llm', prompt: 'hello' },
      ],
    }, options());
    expect(result.diagnostics.filter((d) => d.kind === UNENFORCED)).toEqual([]);
  });

  it('keeps the invalid_spec refusal for a malformed declaration and warns about nothing', () => {
    const result = preflight(agentFlow({ fileGlobs: 'src/**' }), options());
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.kind)).toEqual(['invalid_spec']);
  });

  it('warns beside a cli_unresolved refusal without reaching any environment probe', () => {
    const o = options();
    const result = preflight({
      version: '0.1.0',
      steps: [{ id: 'review', type: 'agent', instruction: 'Review.', permissions: { accessPreset: 'readonly' } }],
    }, o);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.kind)).toEqual([UNENFORCED, 'cli_unresolved']);
    expect(o.probes.cli).not.toHaveBeenCalled();
    expect(o.probes.command).not.toHaveBeenCalled();
    expect(o.probes.executor).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty declaration', {}],
    ['a full declaration', { fileGlobs: ['src/**'], networkAllowlist: ['api.example.com'], accessPreset: 'readonly' }],
  ] as const)('survives the kernel snake_case round trip for %s', (_label, permissions) => {
    const kernel = toKernelSpec(compileSpec(agentFlow(permissions)));
    expect(kernel.steps[0]).toMatchObject({ permissions: expect.any(Object) });
    const result = preflight(kernelToAuthoring(kernel), options());
    expect(result.diagnostics.filter((d) => d.kind === UNENFORCED)).toEqual([
      expect.objectContaining({ severity: 'warning', kind: UNENFORCED, stepId: 'review' }),
    ]);
  });

  // Data-API coverage of `checkAuthoredFlow(FlowSpec, path)` only. An
  // arbitrary `f.agent(..., { permissions })` call inside a TypeScript body is
  // not inspected at authoring time and is outside this warning's reach.
  it('reports the warning through the checkAuthoredFlow data API', () => {
    const directory = temporaryProject();
    const report = checkAuthoredFlow({
      version: '0.1.0',
      steps: [{ id: 'review', type: 'agent', cli: './agent-cli', instruction: 'Review.',
        permissions: { accessPreset: 'readonly' } }],
    } as never, join(directory, 'flow.yaml')).report;
    expect(report.ok).toBe(true);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning', kind: UNENFORCED, stepId: 'review',
      message: expect.stringContaining(READONLY_SENTENCE),
    }));
  });
});

describe('flows check surfaces the unenforced declaration to the author', () => {
  const writeFlow = (directory: string): string => {
    const path = join(directory, 'sandboxed.flow.yaml');
    writeFileSync(path, `
version: '0.1.0'
steps:
  - id: review
    type: agent
    cli: ./agent-cli
    instruction: Review the product test lane.
    permissions:
      fileGlobs: ["src/**"]
      accessPreset: readonly
`);
    return path;
  };

  it('passes with exit 0 and a WARNING line on stderr', async () => {
    const path = writeFlow(temporaryProject());
    const output = capture();
    const code = await runCli(['check', path], output.io);
    expect(code, output.stderr.join('\n')).toBe(0);
    expect(output.stdout.join('\n')).toContain('CHECK PASSED');
    expect(output.stderr.join('\n')).toContain(`WARNING [${UNENFORCED}]`);
    expect(output.stderr.join('\n')).toContain(NOT_ENFORCED);
    expect(output.stderr.join('\n')).toContain(READONLY_SENTENCE);
  });

  it('carries the diagnostic in --json without adding non-JSON text to stdout', async () => {
    const path = writeFlow(temporaryProject());
    const output = capture();
    const code = await runCli(['check', '--json', path], output.io);
    expect(code, output.stderr.join('\n')).toBe(0);
    expect(output.stdout).toHaveLength(1);
    const report = JSON.parse(output.stdout[0]!) as CheckReport;
    expect(report.ok).toBe(true);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning', kind: UNENFORCED, stepId: 'review',
    }));
  });
});

/**
 * The boundary of the warning, pinned so it cannot drift from what
 * `PermissionsSpec`'s doc comment promises. `flows check` on a `.flow.ts`
 * preflights the flow header and never executes the body
 * (`cli/check-typescript.ts`), so an `f.agent(..., { permissions })` call is not
 * a step yet and nothing warns. If body inspection or gate-8 enforcement lands,
 * this test fails and the doc comment is the thing to correct.
 */
describe('an authored TypeScript body is out of reach, and spec.ts says so', () => {
  it('checks clean on a .flow.ts whose body declares permissions', async () => {
    const directory = temporaryProject();
    symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
    const path = join(directory, 'sandboxed.flow.ts');
    writeFileSync(path, `import { flow } from '@relayflows/surface';
export default flow('sandboxed', async f => {
  await f.agent('review', { task: 'Review.', cli: 'claude', permissions: { accessPreset: 'readonly' } });
  f.done('success');
});
`);
    const output = capture();
    const code = await runCli(['check', '--json', path], output.io);
    expect(code, output.stderr.join('\n')).toBe(0);
    const report = JSON.parse(output.stdout[0]!) as CheckReport;
    // The flow did load and the call was read — requirements name the agent —
    // so the silence is preflight's blind spot, not a failure to find the flow.
    expect(report.requirements?.harnessUses).toEqual([{ harness: 'claude', detail: 'agent "review"' }]);
    expect(report.diagnostics.filter((d) => d.kind === UNENFORCED)).toEqual([]);
    const comment = readFileSync(new URL('../src/spec.ts', import.meta.url), 'utf8');
    expect(comment).toContain('A declaration inside an authored `.flow.ts` body is');
  });
});
