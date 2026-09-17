import { flow } from '@relayflows/surface';

// The production shape this pins: the flow's real work lands (a pull request is
// opened) and the body then declares its own adverse verdict. Both steps
// succeed; only the verdict is adverse.
export default flow('step-failed', async f => {
  await f.run('printf "https://github.com/AgentWorkforce/cloud-e2e-sandbox/pull/25"');
  await f.run('printf "adversary review found problems"');
  f.done('step_failed');
});
