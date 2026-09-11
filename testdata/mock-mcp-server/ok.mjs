import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';

if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, env: process.env }));
const tools = ['echo', 'add'].map(name => ({ name, inputSchema: { type: 'object' } }));
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (process.argv[3]) appendFileSync(process.argv[3], JSON.stringify({ pid: process.pid, method: request.method }) + '\n');
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = {
    protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1.0' },
  };
  else if (request.method === 'tools/list') result = { tools };
  else if (request.method === 'tools/call') result = {
    content: [{ type: 'text', text: JSON.stringify(request.params.arguments) }],
    structuredContent: request.params.arguments,
  };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
