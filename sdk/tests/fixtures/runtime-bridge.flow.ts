import { flow } from '@relayflows/surface';

export default flow(
  'runtime-bridge-fixture',
  { identity: 'fixture-agent', tools: { mcp: ['fixture-tool'] } },
  async (f) => {
    f.done('success');
  },
);
