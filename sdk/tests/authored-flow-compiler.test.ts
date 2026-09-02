import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileAuthoredFlow } from '../src/authored-flow-compiler.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('authored flow compiler', () => {
  it('compiles direct input and await topology into journal dependencies', async () => {
    const flow = await compileAuthoredFlow(
      join(FIXTURES, 'direct-topology.flow.ts'),
      { subject: 'relay' },
    );

    expect(flow).toMatchObject({
      name: 'direct-topology',
      steps: [
        { id: 'run-1', command: 'printf seed-relay' },
        { id: 'run-2', command: 'printf left-relay', dependsOn: ['run-1'] },
        { id: 'run-3', command: 'printf right-relay', dependsOn: ['run-1'] },
        { id: 'run-4', command: 'printf joined-relay', dependsOn: ['run-2', 'run-3'] },
      ],
    });
  });

  it('fails closed when author code reads a runtime step output during compilation', async () => {
    await expect(compileAuthoredFlow(
      join(FIXTURES, 'output-dependent.flow.ts'),
      {},
    )).rejects.toThrow('output-dependent authored control flow is not yet supported');
  });

  it('fails closed instead of dropping header fields absent from the kernel contract', async () => {
    await expect(compileAuthoredFlow(
      join(FIXTURES, 'runtime-bridge.flow.ts'),
      {},
    )).rejects.toThrow('unsupported direct-run header fields: identity, tools');
  });
});
