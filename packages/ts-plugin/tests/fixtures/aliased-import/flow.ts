import { flow as defineFlow } from '@relayflows/surface';

export default defineFlow('example', { workspce: 'demo' }, async () => {
  // Checking a definition must never execute its body.
  throw new Error("fixture body executed");
});
