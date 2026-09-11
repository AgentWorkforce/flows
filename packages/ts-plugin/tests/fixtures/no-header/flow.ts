import { flow } from '@relayflows/surface';

export default flow('example', async () => {
  // Checking a definition must never execute its body.
  throw new Error("fixture body executed");
});
