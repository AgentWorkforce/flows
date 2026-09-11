import { flow } from '@relayflows/surface';

export default flow('example', { ['identty']: 'demo' }, async () => {
  // Checking a definition must never execute its body.
  throw new Error("fixture body executed");
});
