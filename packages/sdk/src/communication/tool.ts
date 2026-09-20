/** Standalone helper source also works when the SDK is bundled into a binary. */
export const toolSource = String.raw`
import { createConnection } from 'node:net';
import { once } from 'node:events';
async function main() {
  const path = process.env.RELAYFLOW_COMMUNICATION_SOCKET;
  const token = process.env.RELAYFLOW_COMMUNICATION_TOKEN;
  if (!path || !token) throw new Error('No communication session attached to this agent');
  const [operation, ...values] = process.argv.slice(2);
  if (!['send', 'ack', 'complete'].includes(operation)) throw new Error('Use send PEER ID TEXT, ack PEER SEQ, or complete SUMMARY');
  const socket = createConnection(path);
  await once(socket, 'connect');
  socket.setTimeout(30_000, () => socket.destroy(new Error('Communication tool timed out')));
  socket.end(JSON.stringify({ token, operation, values }) + '\n');
  let text = '';
  for await (const chunk of socket) text += chunk;
  const result = JSON.parse(text);
  if (typeof result.error === 'string') throw new Error(result.error);
  process.stdout.write(JSON.stringify(result.result) + '\n');
}
void main().catch(error => { console.error(error.message); process.exitCode = 1; });
`;
