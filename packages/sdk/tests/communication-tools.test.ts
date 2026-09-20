import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { it, expect } from 'vitest';
import { openCommunicationTools } from '../src/communication/tools.js';
const exec = promisify(execFile);
it('runs the standalone helper and reports journal errors to its caller', async () => {
  const seen: unknown[] = [];
  const tools = await openCommunicationTools(async request => {
    seen.push(request);
    if (request.operation === 'ack') throw new Error('journal write failed');
    return { seq: 12 };
  });
  const env = { ...process.env, RELAYFLOW_COMMUNICATION_SOCKET: tools.path, RELAYFLOW_COMMUNICATION_TOKEN: tools.token };
  try {
    const result = await exec(process.execPath, [tools.helperPath, 'send', 'reviewer', 'v1', 'hello'], { env });
    expect(JSON.parse(result.stdout)).toEqual({ seq: 12 });
    expect(seen).toEqual([{ operation: 'send', values: ['reviewer', 'v1', 'hello'] }]);
    await expect(exec(process.execPath, [tools.helperPath, 'ack', 'reviewer', '12'], { env })).rejects.toThrow(/journal write failed/);
  } finally { await tools.close(); }
});
