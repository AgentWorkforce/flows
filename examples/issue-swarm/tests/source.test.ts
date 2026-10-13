import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Ctx } from '@relayflows/surface';
import { getFlowDefinition } from '@relayflows/surface/runtime';

test('saved source runs with fakes after copying without sibling modules', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  await mkdir(`${root}dist`, { recursive: true });
  const directory = await mkdtemp(`${root}dist/source-copy-`);
  try {
    const source = await readFile(`${root}issue-swarm.flow.ts`, 'utf8');
    assert.ok(!/from ["']\.\.?\//.test(source));
    await writeFile(`${directory}/issue-swarm.flow.ts`, source);
    const { default: handle } = await import(pathToFileURL(`${directory}/issue-swarm.flow.ts`).href);
    const commands: string[] = [];
    const reasons: string[] = [];
    await getFlowDefinition(handle).body({
      run: async (command: string) => {
        commands.push(command);
        if (command.startsWith('command -v')) return '';
        if (command === 'gh repo view --json nameWithOwner,defaultBranchRef') return JSON.stringify({ nameWithOwner: 'acme/widgets', defaultBranchRef: { name: 'main' } });
        if (command.startsWith('gh repo view "')) return 'acme/widgets';
        if (command.startsWith('gh issue list')) return '[]';
        throw Error(`Unexpected effect ${command}`);
      },
      done: (reason: string) => reasons.push(reason),
    } as unknown as Ctx, { label: 'agent' });
    assert.deepEqual(reasons, ['success']);
    assert.equal(commands.length, 4);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
