import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CheckReport, type CliIo } from '../src/cli.js';
import { checkFlow } from '../src/cli/check.js';
import { CHECK_WARNING_KINDS } from '../src/failure-kinds.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * One ordered transcript, not two arrays.
 *
 * The claim under test is positional — the warning reads as a footnote to
 * `REQUIRES`, so it has to land *between* that line and `CHECK PASSED`.
 * Capturing stdout and stderr separately would discard exactly the fact being
 * asserted, so both streams are recorded into a single list, tagged with the
 * stream they were written to.
 */
function transcript(): { io: CliIo; lines: string[]; on: (stream: 'stdout' | 'stderr') => string[] } {
  const lines: string[] = [];
  return {
    io: { stdout: (line) => lines.push(`out ${line}`), stderr: (line) => lines.push(`err ${line}`) },
    lines,
    on: (stream) => lines.filter(line => line.startsWith(stream === 'stdout' ? 'out ' : 'err '))
      .map(line => line.slice(4)),
  };
}

/**
 * A project boundary, so an ambient /tmp/flows.json cannot reach the fixture.
 *
 * `name` decides whether the flow renders a `REQUIRES` line at all:
 * `describeFlowRequirements` reports a harness only when the CLI's basename is
 * a known one, so `claude` produces the line and `agent-cli` does not. Both
 * shapes are real, and the warning has to be placed correctly in each.
 */
function project(flow: string, { config = {}, name = 'agent-cli' }: {
  config?: Record<string, unknown>;
  name?: string;
} = {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'flows-worker-surface-'));
  directories.push(directory);
  writeFileSync(join(directory, 'flows.json'), JSON.stringify({ executors: [], ...config }));
  const cli = join(directory, name);
  // Answers all three preflight probes, so nothing unrelated to the worker
  // question refuses: adapter handshake, `auth status`, and — for a CLI whose
  // basename implies a default model — the model-scoped readiness probe.
  writeFileSync(cli, [
    '#!/bin/sh',
    'case "${1-}" in',
    "  --relayflows-adapter-v1) printf '%s\\n' relayflows-agent-cli-v1 ;;",
    '  auth) test "$2" = status ;;',
    "  -p) printf '%s\\n' RELAYFLOWS_MODEL_READY ;;",
    '  *) exit 9 ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(cli, 0o755);
  const path = join(directory, 'flow.flow.yaml');
  writeFileSync(path, `# yaml-language-server: $schema=x\n${flow.replaceAll('<cli>', `./${name}`)}`);
  return path;
}

const agentStep = (id: string) => `  - id: ${id}\n    type: agent\n    cli: <cli>\n    instruction: Do the thing.\n`;
const flowOf = (steps: string) => `version: '0.1.0'\nname: surface\nsteps:\n${steps}`;

function warning(report: CheckReport): CheckReport['diagnostics'][number] | undefined {
  return report.diagnostics.find(diagnostic => diagnostic.kind === 'agent_worker_unresolved');
}

describe('agent_worker_unresolved', () => {
  it('is a declared check warning kind, suppressible and deletable on its own', () => {
    expect(CHECK_WARNING_KINDS).toContain('agent_worker_unresolved');
  });

  it('names --local-agent, the steps, and what happens without a worker', () => {
    const report = checkFlow(project(flowOf(agentStep('implement'))), { warnUnresolvedAgentWorker: true }).report;

    const diagnostic = warning(report);
    expect(diagnostic).toMatchObject({ severity: 'warning', kind: 'agent_worker_unresolved' });
    expect(diagnostic!.message).toContain('--local-agent');
    expect(diagnostic!.message).toContain('"implement"');
    // Worded as a requirement, not a prediction: attachment is unknown here.
    expect(diagnostic!.message).toContain('1 agent step');
    expect(diagnostic!.message).toContain('parks');
  });

  it('agrees in number with the steps it counts, and stops naming them at three', () => {
    const many = checkFlow(project(flowOf(['a', 'b', 'c', 'd'].map(agentStep).join(''))),
      { warnUnresolvedAgentWorker: true }).report;

    expect(warning(many)!.message).toContain('4 agent steps ("a", "b", "c" and 1 more) require');
  });

  it('warns without refusing: a flow whose only complaint is the worker still passes', async () => {
    const output = transcript();

    const code = await runCli(['check', project(flowOf(agentStep('implement')))], output.io);

    expect(code).toBe(0);
    expect(output.on('stdout').some(line => line.startsWith('CHECK PASSED'))).toBe(true);
  });

  it('is emitted once, after REQUIRES and before CHECK PASSED', async () => {
    const output = transcript();

    await runCli(['check', project(flowOf(agentStep('implement') + agentStep('review')), { name: 'claude' })], output.io);

    const requires = output.lines.findIndex(line => line.startsWith('out REQUIRES'));
    const warned = output.lines.filter(line => line.includes('[agent_worker_unresolved]'));
    const passed = output.lines.findIndex(line => line.startsWith('out CHECK PASSED'));
    // The line this annotates: it already names the steps needing a worker.
    expect(requires, output.lines.join('\n')).toBeGreaterThanOrEqual(0);
    expect(warned, output.lines.join('\n')).toHaveLength(1);
    // Diagnostics stay on stderr; report lines stay on stdout.
    expect(warned[0]!.startsWith('err ')).toBe(true);
    expect(output.lines.indexOf(warned[0]!)).toBeGreaterThan(requires);
    expect(output.lines.indexOf(warned[0]!)).toBeLessThan(passed);
  });

  it('still lands before CHECK PASSED when there is no REQUIRES line to follow', async () => {
    // An unrecognised CLI basename is no harness, so nothing renders a
    // `REQUIRES` line. The warning must not vanish with the line it annotates.
    const output = transcript();

    await runCli(['check', project(flowOf(agentStep('implement')))], output.io);

    const warned = output.lines.filter(line => line.includes('[agent_worker_unresolved]'));
    const passed = output.lines.findIndex(line => line.startsWith('out CHECK PASSED'));
    expect(output.lines.some(line => line.startsWith('out REQUIRES'))).toBe(false);
    expect(warned, output.lines.join('\n')).toHaveLength(1);
    expect(output.lines.indexOf(warned[0]!)).toBeLessThan(passed);
  });

  it('counts a YAML helper step, which compiles to an agent step needing the same worker', () => {
    const report = checkFlow(project(flowOf(
      '  - id: notify\n    slack:\n      post:\n        channel: "#eng"\n        text: done\n',
    )), { warnUnresolvedAgentWorker: true }).report;

    // `requirements` is the wrong source for this count: it reports the helper
    // as an integration, never as a step that needs an agent worker.
    expect(report.requirements?.harnessUses ?? []).toEqual([]);
    expect(warning(report)!.message).toContain('"notify"');
  });

  it('is silent for flows with no agent steps', () => {
    const deterministic = checkFlow(project(flowOf('  - id: build\n    type: deterministic\n    command: "true"\n')),
      { warnUnresolvedAgentWorker: true }).report;
    const llm = checkFlow(project(flowOf('  - id: draft\n    type: llm\n    model: test-model-v1\n    instruction: Draft.\n'),
      { config: { models: ['test-model-v1'] } }), { warnUnresolvedAgentWorker: true }).report;

    // `--local-agent` attaches no `llm` worker, so naming it for an `llm` step
    // would be false.
    expect(warning(deterministic)).toBeUndefined();
    expect(warning(llm)).toBeUndefined();
  });

  it('survives a preflight refusal, because the worker question is open on the next pass', () => {
    const report = checkFlow(project(flowOf('  - id: implement\n    type: agent\n    cli: ./absent-cli\n    instruction: Do it.\n')),
      { warnUnresolvedAgentWorker: true }).report;

    expect(report.ok).toBe(false);
    expect(report.diagnostics.some(diagnostic => diagnostic.severity === 'refusal')).toBe(true);
    expect(warning(report)).toBeDefined();
  });

  it('is opt-in: a caller that did not ask is not told', () => {
    const path = project(flowOf(agentStep('implement')));

    // `flows run` (cli/run.ts) and `flows build` both reach check this way.
    expect(warning(checkFlow(path).report)).toBeUndefined();
    expect(warning(checkFlow(path, {}).report)).toBeUndefined();
    expect(warning(checkFlow(path, { warnUnresolvedAgentWorker: false }).report)).toBeUndefined();
  });

  it('appears once in --json, in the payload and on stderr', async () => {
    const output = transcript();

    await runCli(['check', '--json', project(flowOf(agentStep('implement')))], output.io);

    const payload = JSON.parse(output.on('stdout').at(-1)!) as CheckReport;
    expect(payload.diagnostics.filter(d => d.kind === 'agent_worker_unresolved')).toHaveLength(1);
    expect(output.on('stderr').filter(line => line.includes('[agent_worker_unresolved]'))).toHaveLength(1);
  });
});
