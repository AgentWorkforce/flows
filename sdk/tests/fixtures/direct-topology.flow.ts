import { flow } from '@relayflows/surface';

export default flow<{ subject: string }>('direct-topology', {}, async (f, input) => {
  await f.run(`printf seed-${input.subject}`);
  await Promise.all([
    f.run(`printf left-${input.subject}`),
    f.run(`printf right-${input.subject}`),
  ]);
  await f.run(`printf joined-${input.subject}`);
});
