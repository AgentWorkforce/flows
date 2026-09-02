import { flow } from '@relayflows/surface';

export default flow('output-dependent', {}, async (f) => {
  const first = await f.run('printf first');
  await f.run(`printf ${first}`);
});
