import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentCwdError,
  agentCwdDeclarationError,
  agentStepCwd,
  resolveAgentCwd,
} from '../src/agent-cwd.js';
import { compileSpec, kernelToAuthoring, toKernelSpec } from '../src/compile.js';
import { validateSpec } from '../src/validate.js';
import { runCli, type CheckReport, type CliIo } from '../src/cli.js';

// flows#357. `cwd` was accepted by the SDK, lowered into the step spec, and
// then refused by the kernel with `unknown field "cwd" at steps[0]` — after
// `flows check` had passed. These pin the declaration rule (shared with the
// kernel through testdata/agent-cwd-cases.json), the dialect round trip, and
// the containment the worker does on the host that runs the CLI.

const cases: Array<{ name: string; cwd: string; valid: boolean }> =
  JSON.parse(readFileSync(new URL('../../../testdata/agent-cwd-cases.json', import.meta.url), 'utf8'));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A run root with two checkouts and a sibling name that merely shares a prefix. */
function runRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flows-agent-cwd-')));
  roots.push(root);
  mkdirSync(join(root, 'checkouts', 'service-a'), { recursive: true });
  mkdirSync(join(root, 'checkouts', 'service-b'), { recursive: true });
  writeFileSync(join(root, 'checkouts', 'service-a', 'README'), 'a');
  return root;
}

const agentFlow = (cwd: unknown, extra: Record<string, unknown> = {}): unknown => ({
  version: '0.1.0',
  steps: [{ id: 'edit', type: 'agent', instruction: 'Edit.', cwd, ...extra }],
});

describe('the declaration rule is the kernel rule', () => {
  for (const test of cases) {
    it(`${test.valid ? 'accepts' : 'refuses'} ${test.name}`, () => {
      expect(agentCwdDeclarationError(test.cwd) === undefined).toBe(test.valid);
      expect(validateSpec(agentFlow(test.cwd)).ok).toBe(test.valid);
    });
  }

  // `Option<String>` in the kernel reads an explicit null as absence. The SDK
  // must not let one through under a different name for the same silence.
  it.each([
    ['null', null],
    ['a number', 7],
    ['an array', ['checkouts/service-a']],
    ['an object', { path: 'checkouts/service-a' }],
    ['a boolean', true],
  ])('refuses %s rather than treating it as absence', (_label, cwd) => {
    expect(agentCwdDeclarationError(cwd)).toContain('expected a run-root-relative path');
    const result = validateSpec(agentFlow(cwd));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('steps[0].cwd');
  });

  it('says nothing about a step that declares no directory', () => {
    expect(agentCwdDeclarationError(undefined)).toContain('expected a run-root-relative path');
    expect(validateSpec({ version: '0.1.0', steps: [{ id: 'edit', type: 'agent', instruction: 'Edit.' }] }).ok)
      .toBe(true);
  });
});

describe('the declaration survives the kernel dialect', () => {
  it('round-trips through snake_case and back', () => {
    const compiled = compileSpec(agentFlow('checkouts/service-a'));
    const kernel = toKernelSpec(compiled);
    expect(kernel.steps[0]).toMatchObject({ cwd: 'checkouts/service-a' });
    expect(kernelToAuthoring(kernel)).toEqual(compiled);
  });

  // The inverse mapping dropped `cwd` on the floor, so a kernel spec that
  // declared a directory came back as one that did not — the same class of
  // silence as the field the kernel refused outright.
  it('does not lose the directory on the way back from the kernel', () => {
    const kernel = toKernelSpec(compileSpec(agentFlow('checkouts/service-a')));
    const authoring = kernelToAuthoring(kernel) as { steps: Array<{ cwd?: string }> };
    expect(authoring.steps[0]?.cwd).toBe('checkouts/service-a');
  });

  it('refuses a cwd the authoring dialect would have to invent a value for', () => {
    const kernel = toKernelSpec(compileSpec(agentFlow('checkouts/service-a')));
    (kernel.steps[0] as Record<string, unknown>)['cwd_hint'] = 'checkouts/service-b';
    expect(() => kernelToAuthoring(kernel)).toThrow('steps[0]');
  });
});

describe('the worker resolves the declaration against the run root', () => {
  it('runs in the run root itself when nothing is declared', () => {
    expect(resolveAgentCwd(runRoot(), undefined)).toBeUndefined();
  });

  it('resolves a nested checkout to its real path', () => {
    const root = runRoot();
    expect(resolveAgentCwd(root, 'checkouts/service-a')).toBe(join(root, 'checkouts', 'service-a'));
  });

  it('resolves two sibling checkouts independently', () => {
    const root = runRoot();
    expect(resolveAgentCwd(root, 'checkouts/service-a')).not.toBe(resolveAgentCwd(root, 'checkouts/service-b'));
  });

  it('refuses a directory that is not there', () => {
    expect(() => resolveAgentCwd(runRoot(), 'checkouts/service-c'))
      .toThrow(/no such directory under the run root/);
  });

  it('refuses a path that names a regular file', () => {
    expect(() => resolveAgentCwd(runRoot(), 'checkouts/service-a/README'))
      .toThrow(/is not a directory/);
  });

  // Containment is component-aware on the symlink-free form of both paths, so
  // a name that merely shares the root's prefix is outside it.
  it('refuses a sibling whose name starts with the run root', () => {
    const root = runRoot();
    const sibling = `${root}-old`;
    mkdirSync(sibling, { recursive: true });
    roots.push(sibling);
    // Reached through a symlink, because the lexical rule refuses `..`.
    symlinkSync(sibling, join(root, 'nearby'), 'dir');
    expect(() => resolveAgentCwd(root, 'nearby')).toThrow(/outside the run root/);
  });

  it('refuses a symlink pointing out of the run root', () => {
    const root = runRoot();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'flows-agent-cwd-outside-')));
    roots.push(outside);
    symlinkSync(outside, join(root, 'escape'), 'dir');
    expect(() => resolveAgentCwd(root, 'escape')).toThrow(/outside the run root/);
  });

  it('follows a symlink that stays inside the run root', () => {
    const root = runRoot();
    symlinkSync(join(root, 'checkouts', 'service-a'), join(root, 'current'), 'dir');
    expect(resolveAgentCwd(root, 'current')).toBe(join(root, 'checkouts', 'service-a'));
  });

  it('refuses a declaration the lexical rule already rejects, without touching the disk', () => {
    expect(() => resolveAgentCwd(runRoot(), '../sibling')).toThrow(AgentCwdError);
    expect(() => resolveAgentCwd(runRoot(), '/etc')).toThrow(/not an absolute path/);
  });

  // The relay agent runs on another host. Forwarding the string would let a
  // declaration this contract promises to contain go unchecked.
  it('refuses a directory declared on a relay-dispatched step', () => {
    expect(() => resolveAgentCwd(runRoot(), 'checkouts/service-a', 'relay'))
      .toThrow(/not supported with transport "relay"/);
    expect(validateSpec(agentFlow('checkouts/service-a', { transport: 'relay' })).ok).toBe(false);
  });

  it('leaves a relay step that declares no directory alone', () => {
    expect(resolveAgentCwd(runRoot(), undefined, 'relay')).toBeUndefined();
    expect(validateSpec({
      version: '0.1.0',
      steps: [{ id: 'edit', type: 'agent', instruction: 'Edit.', transport: 'relay' }],
    }).ok).toBe(true);
  });
});

describe('a refused dispatch is reported, not thrown at the worker', () => {
  it('names the step and the declaration', () => {
    const outcome = agentStepCwd({ cwd: '../sibling' }, 'edit', runRoot());
    expect(outcome).toEqual({ refusal: expect.stringContaining('agent step "edit": cwd "../sibling"') });
  });

  it('reports a directory that is not there rather than spawning somewhere else', () => {
    const outcome = agentStepCwd({ cwd: 'checkouts/service-c' }, 'edit', runRoot());
    expect('refusal' in outcome && outcome.refusal).toContain('no such directory under the run root');
  });

  it('hands back the resolved directory when the declaration holds', () => {
    const root = runRoot();
    expect(agentStepCwd({ cwd: 'checkouts/service-b' }, 'edit', root))
      .toEqual({ directory: join(root, 'checkouts', 'service-b') });
  });

  it('hands back nothing to resolve when the step declares nothing', () => {
    expect(agentStepCwd({}, 'edit', runRoot())).toEqual({ directory: undefined });
  });
});

/**
 * The ticket's headline: "`flows check` passes so nothing catches it before the
 * run." The declaration is lexical, so `check` is exactly where an unusable one
 * must be named — before a run exists, not at dispatch.
 */
describe('flows check names a bad declaration before a run exists', () => {
  function project(cwd: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'flows-agent-cwd-check-'));
    roots.push(directory);
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
    const path = join(directory, 'edit.flow.yaml');
    writeFileSync(path, [
      "version: '0.1.0'",
      'steps:',
      '  - id: edit',
      '    type: agent',
      `    cli: ${JSON.stringify(cli)}`,
      '    instruction: Edit the checkout.',
      `    cwd: ${JSON.stringify(cwd)}`,
      '',
    ].join('\n'));
    return path;
  }

  function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return { io: { stdout: line => stdout.push(line), stderr: line => stderr.push(line) }, stdout, stderr };
  }

  it('passes a run-root-relative checkout', async () => {
    const output = capture();
    expect(await runCli(['check', project('checkouts/service-a')], output.io), output.stderr.join('\n')).toBe(0);
    expect(output.stdout.join('\n')).toContain('CHECK PASSED');
  });

  it.each([
    ['an absolute path', '/srv/checkouts/service-a', 'not an absolute path'],
    ['a path that climbs out', '../service-a', 'without empty, "." or ".." components'],
    ['a padded path', ' checkouts/service-a', 'without surrounding whitespace'],
  ])('refuses %s with a reason naming the step', async (_label, cwd, reason) => {
    const output = capture();
    const code = await runCli(['check', project(cwd)], output.io);
    expect(code).not.toBe(0);
    const said = output.stderr.join('\n');
    expect(said).toContain('steps[0].cwd');
    expect(said).toContain(reason);
    expect(output.stdout.join('\n')).not.toContain('CHECK PASSED');
  });

  it('reports the refusal in --json without writing prose to stdout', async () => {
    const output = capture();
    expect(await runCli(['check', '--json', project('/srv/checkouts')], output.io)).not.toBe(0);
    expect(output.stdout).toHaveLength(1);
    const report = JSON.parse(output.stdout[0]!) as CheckReport;
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report.diagnostics)).toContain('steps[0].cwd');
  });
});
