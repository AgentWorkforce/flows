import * as surface from '@relayflows/surface';

export default surface.flow('example', { buget: '$1' }, async () => {
  // Checking a definition must never execute its body.
  throw new Error("fixture body executed");
});
