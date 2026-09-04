import { flow } from '@relayflows/surface';

export default flow(
  'runtime-bridge-fixture',
  async (f) => {
    const output = await f.run('printf authored-journal-ok');
    if (output !== 'authored-journal-ok') {
      throw new Error(`unexpected journal output: ${output}`);
    }
    f.done('success');
  },
);
