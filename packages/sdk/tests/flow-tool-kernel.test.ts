import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalize } from '../src/canonical.js';
import { sealBundle } from '../src/bundle.js';
import { FlowToolClient } from '../src/flow-tool-client.js';
import { createKernelFlowToolControlPlane, FLOW_TOOL_INPUT_PLACEHOLDER } from '../src/flow-tool-kernel.js';
import { createFlowToolManifest } from '../src/flow-tool-manifest.js';
import { JournalProtocolError, type JournalClient } from '../src/journal-client.js';
import type { FlowToolCatalogEntryV1 } from '../src/flow-tool-contract.js';
import type { KernelRunSpec } from '../src/spec.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const schema = {
  type: 'object' as const,
  properties: { message: { type: 'string' as const, maxLength: 1000 } },
  required: ['message'],
  additionalProperties: false as const,
};

async function deployment(patch: { budgetTokens?: number; verdict?: string; resultSchema?: typeof schema } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flow-tool-kernel-'));
  directories.push(root);
  const spec = { version: '0.1.0', name: 'echo-json', description: 'echo', steps: [{
    id: 'flow-tool-result', type: 'deterministic',
    command: ['/usr/bin/printf', '%s', FLOW_TOOL_INPUT_PLACEHOLDER], depends_on: [], max_iterations: 1,
    retry: { initial_backoff_ms: 0, max_backoff_ms: 0, multiplier: 1, jitter_percent: 0 },
    verification: {}, timeout_ms: 2_000,
  }] };
  const bundlePath = await sealBundle({ name: 'echo-json', out: root, repo: root, env: {
    FLOWS_BUILD_KEY: Buffer.alloc(32, 9).toString('base64'),
  }, warn: () => {}, files: [
    { path: 'spec.canonical.json', data: canonicalize(spec) },
    { path: 'preflight.json', data: canonicalize({ ok: true, diagnostics: [] }) },
    { path: 'lockfile.json', data: canonicalize({ version: 2, plugins: [] }) },
  ] });
  const digest = basename(bundlePath).split('@sha256:')[1]!;
  const verdict = patch.verdict ?? 'echoed';
  const entry: FlowToolCatalogEntryV1 = {
    manifest: createFlowToolManifest({ name: 'echo_json', description: 'Effect-free kernel conformance tool.',
      flow: { name: 'echo-json', version: '1.0.0', digest: `sha256:${digest}` },
      inputSchema: schema, resultSchema: patch.resultSchema ?? schema }),
    deployment_id: 'echo_deployment', read_only: true, effects: [], requires_human: [],
    business_verdicts: [verdict], budget: { max_tokens: patch.budgetTokens ?? 1, max_dollars: '0', max_wallclock_ms: 2_000 },
  };
  return { entry, bundlePath, businessVerdict: verdict };
}

function journalDouble() {
  const runs = new Map<string, { key: string; spec: string; stdout: string }>();
  let sequence = 0;
  const journal = {
    async runStart(spec: KernelRunSpec, _reuse?: string, admissionKey?: string) {
      const encoded = canonicalize(spec);
      const existing = [...runs.entries()].find(([, run]) => run.key === admissionKey);
      if (existing) {
        if (existing[1].spec !== encoded) throw new JournalProtocolError('run_admission_conflict', 'different spec');
        return { run_id: existing[0], status: 'completed' as const };
      }
      const runId = `run_${++sequence}`;
      runs.set(runId, { key: admissionKey ?? '', spec: encoded, stdout: JSON.stringify({ message: 'ok' }) });
      return { run_id: runId, status: 'completed' as const };
    },
    async journalRead(runId: string) {
      const run = runs.get(runId);
      if (!run) throw new JournalProtocolError('run_not_found', 'missing');
      const spec = JSON.parse(run.spec) as KernelRunSpec;
      return { entries: [
        { seq: 1, entry_type: 'run.spawned', payload: { spec } },
        { seq: 2, entry_type: 'step.completed', step_id: 'flow-tool-result', payload: { output: { stdout_tail: run.stdout } } },
        { seq: 3, entry_type: 'run.completed', payload: { completionReason: 'success' } },
      ] };
    },
    async runGet() {
      return { status: 'completed', budget: { tokens_in: 0, tokens_out: 0, dollars: '0', dollars_unmetered: false } };
    },
  };
  return { journal: journal as unknown as JournalClient, runs };
}

describe('embedded flow-tool kernel projection', () => {
  it('refuses an echo deployment whose result schema is not the input schema', async () => {
    const deployed = await deployment({ resultSchema: {
      type: 'object', properties: { other: { type: 'string', maxLength: 1000 } },
      required: ['other'], additionalProperties: false,
    } });
    await expect(createKernelFlowToolControlPlane({
      journal: {} as JournalClient, principal: 'principal-a', deployments: [deployed],
      authorizedDeploymentIds: ['echo_deployment'],
    })).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('keeps the same run when the catalog budget or verdict label changes', async () => {
    const { journal, runs } = journalDouble();
    const original = await deployment();
    const first = new FlowToolClient(await createKernelFlowToolControlPlane({
      journal, principal: 'principal-a', deployments: [original],
      authorizedDeploymentIds: ['echo_deployment'],
    }));
    const admitted = await first.invoke(original.entry, { message: 'ok' }, { idempotencyKey: 'operation-1' });
    expect(admitted).toMatchObject({ state: 'completed', terminal: { terminal_reason: 'success', business_verdict: 'echoed' } });
    const description = JSON.parse([...runs.values()][0]!.spec).description as string;
    expect(description).not.toContain('catalog_digest');
    expect(description).not.toContain('business_verdict');
    const changed = await deployment({ budgetTokens: 9, verdict: 'held' });
    const reloaded = new FlowToolClient(await createKernelFlowToolControlPlane({
      journal, principal: 'principal-a', deployments: [changed],
      authorizedDeploymentIds: ['echo_deployment'],
    }));
    const repeated = await reloaded.invoke(changed.entry, { message: 'ok' }, { idempotencyKey: 'operation-1' });
    expect(repeated).toMatchObject({ run_id: admitted.run_id, terminal: { business_verdict: 'held' } });
    expect(runs.size).toBe(1);
  });

  it('does not relabel a journaled success when the echoed result fails its schema', async () => {
    const { journal, runs } = journalDouble();
    const deployed = await deployment();
    const client = new FlowToolClient(await createKernelFlowToolControlPlane({
      journal, principal: 'principal-a', deployments: [deployed],
      authorizedDeploymentIds: ['echo_deployment'],
    }));
    const admitted = await client.invoke(deployed.entry, { message: 'ok' }, { idempotencyKey: 'operation-2' });
    runs.get(admitted.run_id)!.stdout = JSON.stringify({ message: 12 });
    await expect(client.status(deployed.entry, admitted)).rejects.toMatchObject({ code: 'unavailable' });
  });
});
