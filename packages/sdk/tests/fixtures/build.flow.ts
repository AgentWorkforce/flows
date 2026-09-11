import { flow } from '@relayflows/surface';

export const spec = {
  version: '0.1.0', name: 'hello-build-ts',
  steps: [{ id: 'greet', type: 'deterministic', command: 'echo hello' }],
};

// Build retains this program without evaluating its body or requiring input.
export default flow('hello-build-ts', async f => {
  await f.run('echo hello');
  f.done('success');
});
