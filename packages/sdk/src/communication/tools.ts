import { toolSource } from './tool.js';
import { createServer, type Socket } from 'node:net';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export interface CommunicationToolRequest { operation: string; values: string[] }
export async function openCommunicationTools(invoke: (request: CommunicationToolRequest) => Promise<unknown>) {
  const directory = await mkdtemp(join(tmpdir(), 'flows-comm-'));
  const path = join(directory, 'agent.sock');
  const helperPath = join(directory, 'tool.mjs');
  const token = randomBytes(32).toString('hex');
  const sockets = new Set<Socket>();
  let busy = false;
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(30_000, () => socket.destroy());
    let text = '';
    socket.on('data', chunk => {
      text += chunk;
      if (Buffer.byteLength(text) > 32_768) socket.destroy();
    });
    socket.on('end', async () => {
      if (busy) { socket.end(JSON.stringify({ error: 'Call communication tools sequentially' })); return; }
      busy = true;
      try {
        const input = JSON.parse(text);
        if (typeof input.token !== 'string' || Buffer.byteLength(input.token) !== Buffer.byteLength(token)
          || !timingSafeEqual(Buffer.from(input.token), Buffer.from(token))) throw new Error('Unauthorized communication session');
        if (typeof input.operation !== 'string' || !Array.isArray(input.values)
          || !input.values.every((value: unknown) => typeof value === 'string')) throw new Error('Invalid communication tool request');
        socket.end(JSON.stringify({ result: await invoke({ operation: input.operation, values: input.values }) }));
      } catch (error) { socket.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Communication tool failed' })); }
      finally { busy = false; }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    await chmod(path, 0o600);
    await writeFile(helperPath, toolSource, { mode: 0o600 });
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return { path, helperPath, token, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  } };
}
