import { flow } from '@relayflows/surface';

export default flow('bad-model-fixture', {
  agents: { reviewer: { cli: 'claude', model: 'unlisted-model' } },
}, async (f) => {
  await f.agent('reviewer', { task: 'review this' });
  f.done('success');
});
