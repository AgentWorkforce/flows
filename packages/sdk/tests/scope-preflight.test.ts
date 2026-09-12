import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { preflight } from '../src/index.js';
import type { PreflightResult, PreflightProbes, CliProbeResult } from '../src/preflight.js';
import type { FlowSpec } from '../src/spec.js';

const probes: PreflightProbes = {
  cli: (): CliProbeResult => ({ exists: true, authenticated: true, modelAvailable: true }),
  executor: () => true,
  command: () => true,
  helper: () => true,
};

const baseFlow: FlowSpec = {
  version: '0.1.0',
  name: 'scope-test',
  steps: [{ id: 'run', type: 'deterministic', command: 'true', maxIterations: 1 }],
};

describe('preflight — path-scoped auth (#308)', () => {
  it('accepts a grant the mount manifest can satisfy', () => {
    const root = mkdtempSync(join(tmpdir(), 'scope-ok-'));
    try {
      writeFileSync(join(root, 'relayfile.mounts.json'), JSON.stringify({
        version: 1, mounts: { acme: [{ path: 'api', modes: ['readonly', 'readwrite'] }] },
      }));
      const flow: FlowSpec = { ...baseFlow, workspace: 'acme/api: readonly' };
      const result = preflight(flow, { probes, projectSearchStart: root }) as PreflightResult;
      expect(result.diagnostics.filter(d => d.severity === 'refusal')).toEqual([]);
      expect(result.ok).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses a malformed grant with scope_syntax_invalid', () => {
    const flow: FlowSpec = { ...baseFlow, workspace: 'not-a-grant' };
    const result = preflight(flow, { probes }) as PreflightResult;
    const refusal = result.diagnostics.find(d => d.severity === 'refusal' && d.kind === 'scope_syntax_invalid');
    expect(refusal).toBeDefined();
    expect(result.ok).toBe(false);
  });

  it('refuses an unknown mount with mount_unknown when a manifest is present', () => {
    const root = mkdtempSync(join(tmpdir(), 'scope-unknown-'));
    try {
      writeFileSync(join(root, 'relayfile.mounts.json'), JSON.stringify({
        version: 1, mounts: { acme: [{ path: 'api', modes: ['readonly'] }] },
      }));
      const flow: FlowSpec = { ...baseFlow, workspace: 'other/api: readonly' };
      const result = preflight(flow, { probes, projectSearchStart: root }) as PreflightResult;
      const refusal = result.diagnostics.find(d => d.severity === 'refusal' && d.kind === 'mount_unknown');
      expect(refusal).toBeDefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses an out-of-scope path or mode with scope_ungrantable', () => {
    const root = mkdtempSync(join(tmpdir(), 'scope-ungrantable-'));
    try {
      writeFileSync(join(root, 'relayfile.mounts.json'), JSON.stringify({
        version: 1, mounts: { acme: [{ path: 'api', modes: ['readonly'] }] },
      }));
      const flowPath: FlowSpec = { ...baseFlow, workspace: 'acme/other: readonly' };
      const pathResult = preflight(flowPath, { probes, projectSearchStart: root }) as PreflightResult;
      expect(pathResult.diagnostics.find(d => d.severity === 'refusal' && d.kind === 'scope_ungrantable')).toBeDefined();

      const flowMode: FlowSpec = { ...baseFlow, workspace: 'acme/api: readwrite' };
      const modeResult = preflight(flowMode, { probes, projectSearchStart: root }) as PreflightResult;
      expect(modeResult.diagnostics.find(d => d.severity === 'refusal' && d.kind === 'scope_ungrantable')).toBeDefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('honors tools.fs the same way as workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'scope-toolsfs-'));
    try {
      writeFileSync(join(root, 'relayfile.mounts.json'), JSON.stringify({
        version: 1, mounts: { acme: [{ path: 'api', modes: ['readwrite'] }] },
      }));
      const flow: FlowSpec = { ...baseFlow, tools: { fs: 'acme/api: readwrite' } };
      const result = preflight(flow, { probes, projectSearchStart: root }) as PreflightResult;
      expect(result.diagnostics.filter(d => d.severity === 'refusal')).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('accepts absence of workspace and tools without probing anything', () => {
    const result = preflight(baseFlow, { probes }) as PreflightResult;
    expect(result.diagnostics.filter(d => d.severity === 'refusal')).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
