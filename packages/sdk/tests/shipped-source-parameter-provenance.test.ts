import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanTypeScript } from './helpers/shipped-source-typescript.js';

describe('shipped-source parameter provenance', () => {
  it('keeps caller-supplied identifier and destructured keys unknown', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shipped-parameter-provenance-'));
    try {
      const workerCases = [
        `function run(key: string) { if (flag) key = 'agent'; f[key]('reviewer', { task: 'x' }); }`,
        `function run({ key }: { key: string }) { if (flag) key = 'agent'; f[key]('reviewer', { task: 'x' }); }`,
      ];
      for (const [index, candidate] of workerCases.entries()) {
        const file = join(directory, `worker-${index}.flow.ts`);
        writeFileSync(file, `declare const f: { agent(name: string, options: object): void; llm(...args: unknown[]): void }; declare const flag: boolean; ${candidate}`);
        const result = scanTypeScript(file);
        expect(result.calls, candidate).toBe(1);
        expect(result.missing, candidate).toHaveLength(1);
      }

      const flowCases = [
        `function define(key: string) { if (flag) key = 'flow'; surface[key]('parameter-key', { budget: '$2' }, () => {}); }`,
        `function define({ key }: { key: string }) { if (flag) key = 'flow'; surface[key]('destructured-parameter-key', { budget: '$2' }, () => {}); }`,
      ];
      for (const [index, candidate] of flowCases.entries()) {
        const file = join(directory, `flow-${index}.flow.ts`);
        writeFileSync(file, `declare const surface: { flow(name: string, header: object, body: () => void): void }; declare const flag: boolean; ${candidate}`);
        expect(scanTypeScript(file).invalidFlowHeaders, candidate).toHaveLength(1);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
