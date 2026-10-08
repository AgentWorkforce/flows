import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flowRequirements, describeFlowRequirements } from '../../packages/sdk/dist/flow-requirements.js';
import { checkAuthoredFlow } from '../../packages/sdk/dist/cli/check.js';

const dir = mkdtempSync(join(tmpdir(), 'requirements-evidence-'));
try {
  writeFileSync(join(dir, 'flows.json'), '{}');
  const base = { version: '0.1.0', name: 'named',
    agents: { reviewer: { cli: 'codex', model: 'gpt-5' } },
    steps: [{ id: 'review', type: 'agent', agent: 'reviewer', instruction: 'Review' }] };
  for (const [name, spec] of [['named-agent', base], ['use', { ...base, use: ['./missing.yaml'] }]]) {
    // This was the complete safeRequirements implementation before Part B.
    console.log(name + ' before: REQUIRES ' + describeFlowRequirements(flowRequirements(spec)));
    const report = checkAuthoredFlow(spec, join(dir, 'flow.yaml')).report;
    console.log(name + ' after: REQUIRES ' + describeFlowRequirements(report.requirements));
    console.log(name + ' refusals: ' + report.diagnostics.filter(d => d.severity === 'refusal').map(d => d.kind).join(', '));
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
