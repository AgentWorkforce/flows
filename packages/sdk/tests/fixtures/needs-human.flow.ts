import { flow } from '@relayflows/surface';

export default flow('needs-human', async f => {
  await f.run('printf "Repair limit exhausted"');
  f.done('needs_human');
});
