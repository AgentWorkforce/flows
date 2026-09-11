import { afterEach, describe, expect, it, vi } from 'vitest';
import { flow } from '@relayflows/surface';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { chainFixture } from './flow-chain-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

describe('authored budgets through the live kernel', () => {
  it('retains the first completion and journals refusal of the next authored step', async () => {
    const fixture = chainFixture();
    cleanup.push(() => fixture.close());
    const client = await fixture.connect();
    const start = vi.spyOn(client, 'runStart');
    const handle = flow('budgeted', {budget: {wallclock: '0ms'}}, async f => {
      await f.run('sleep 0.01');
      await f.run('printf must-not-run');
      f.done('success');
    });
    await expect(executeAuthoredFlow(handle, client)).rejects.toMatchObject({completionReason:'budget_exceeded'});
    expect(start).toHaveBeenCalledTimes(2);
    const first = await start.mock.results[0]!.value;
    const refused = await start.mock.results[1]!.value;
    const entries = (await client.journalRead(first.run_id,1)).entries;
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({entry_type:'step.completed',payload:expect.objectContaining({completionReason:'success',spend:expect.objectContaining({dollars:0})})})]));
    const refusal = (await client.journalRead(refused.run_id,1)).entries;
    expect(refusal).toEqual(expect.arrayContaining([expect.objectContaining({entry_type:'run.completed',payload:expect.objectContaining({completionReason:'budget_exceeded'})})]));
    expect(refusal).not.toEqual(expect.arrayContaining([expect.objectContaining({entry_type:'step.attempt_started'})]));
  });
  it('permits done after the last valid step crosses the limit', async () => {
    const fixture = chainFixture(); cleanup.push(() => fixture.close());
    const client = await fixture.connect();
    const handle = flow('last', {budget:{wallclock:'0ms'}}, async f => { await f.run('sleep 0.01'); f.done('success'); });
    expect((await executeAuthoredFlow(handle,client)).completionReason).toBe('success');
  });
});
