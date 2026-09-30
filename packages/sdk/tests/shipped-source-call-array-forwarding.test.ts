import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanTypeScript } from './helpers/shipped-source-typescript.js';

describe('shipped-source call-array forwarding', () => {
  it('maps rest indexes and nested same-helper actuals for workers and flows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shipped-call-array-forwarding-'));
    try {
      const workerCases = [
        `function pass(...args: any[]) { return args[0]; } Reflect.apply(...pass([f.agent, f, ['review', { task: 'x' }]]));`,
        `const box: any = {}; function pass(...args: any[]) { return args[0]; } Reflect.apply(...pass([Object.assign, Object, [box, { run: f.agent }]])); box.run('review', { task: 'x' });`,
        `function pass(args: any) { return args; } Reflect.apply(...pass(pass([f.agent, f, ['review', { task: 'x' }]])));`,
        `const box: any = {}; function pass(args: any) { return args; } Reflect.apply(...pass(pass([Object.assign, Object, [box, { run: f.agent }]]))); box.run('review', { task: 'x' });`,
      ];
      for (const [index, candidate] of workerCases.entries()) {
        const file = join(directory, `worker-${index}.flow.ts`);
        writeFileSync(file, `declare const f: any; ${candidate}`);
        const result = scanTypeScript(file);
        expect(result.calls, candidate).toBe(1);
        expect(result.missing, candidate).toHaveLength(1);
      }

      const flowCases = [
        `function pass(...args: any[]) { return args[0]; } Reflect.apply(...pass([surface.flow, surface, ['rest-index-callable', { budget: '$2' }, () => {}]]));`,
        `const box: any = {}; function pass(...args: any[]) { return args[0]; } Reflect.apply(...pass([Object.assign, Object, [box, { define: surface.flow }]])); box.define('rest-index-writer', { budget: '$2' }, () => {});`,
        `function pass(args: any) { return args; } Reflect.apply(...pass(pass([surface.flow, surface, ['nested-forwarded-callable', { budget: '$2' }, () => {}]])));`,
        `const box: any = {}; function pass(args: any) { return args; } Reflect.apply(...pass(pass([Object.assign, Object, [box, { define: surface.flow }]]))); box.define('nested-forwarded-writer', { budget: '$2' }, () => {});`,
      ];
      for (const [index, candidate] of flowCases.entries()) {
        const file = join(directory, `flow-${index}.flow.ts`);
        writeFileSync(file, `import * as surface from '@relayflows/surface'; ${candidate}`);
        expect(scanTypeScript(file).invalidFlowHeaders, candidate).toHaveLength(1);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
