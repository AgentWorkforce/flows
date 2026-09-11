import { flow } from '@relayflows/surface';

export default flow('example', { identity: 'demo', memory: { script: true, agent: true }, budget: '$1', tools: { relayfile: [], mcp: [], slack: false }, workspace: 'demo' }, async () => {
  // Checking a definition must never execute its body.
  throw new Error("fixture body executed");
});
