import { writeFileSync } from 'node:fs';
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid }));
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === 'tools/call') {
    process.stdout.end('{"jsonrpc":"2.0","id":');
    return;
  }
  const result = request.method === 'initialize'
    ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'drop', version: '1.0' } }
    : { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
