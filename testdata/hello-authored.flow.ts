import { flow } from '@relayflows/surface';

export default flow('hello-authored', {}, async (f) => {
  await f.run('echo hello');
  f.done('success');
});
