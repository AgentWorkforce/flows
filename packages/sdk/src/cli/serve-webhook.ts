import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink, lstat } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import type { CliIo } from '../cli.js';

const MAX_BODY_BYTES = 1024 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function parseWebhookArgs(args: readonly string[]): {
  command: 'serve-webhook'; dataDir: string; port: number;
} | undefined {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (!['--data-dir', '--port'].includes(flag) || values.has(flag)
      || !value || value.startsWith('-')) return undefined;
    values.set(flag, value);
  }
  const dataDir = values.get('--data-dir');
  const portText = values.get('--port');
  if (!dataDir || !portText || !/^\d+$/.test(portText)) return undefined;
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return undefined;
  return { command: 'serve-webhook', dataDir, port };
}

function reply(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** POST /<name> accepts JSON, including scalar values. No daemon connection. */
export async function startWebhookServer(dataDir: string, port: number): Promise<Server> {
  const inbox = join(resolve(dataDir), 'inbox');
  await directory(inbox);
  // TODO https://github.com/AgentWorkforce/flows/issues/301: provider signatures,
  // public ingress and Cloud mount provisioning belong to the deployment slice.
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      request.resume();
      response.setHeader('allow', 'POST');
      reply(response, 405, { error: 'method_not_allowed' });
      return;
    }
    const name = request.url?.slice(1);
    if (!name || !NAME.test(name)) {
      request.resume();
      reply(response, 404, { error: 'invalid_webhook_name' });
      return;
    }
    let temporary: string | undefined;
    try {
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk as Uint8Array);
        bytes += buffer.length;
        if (bytes > MAX_BODY_BYTES) {
          reply(response, 413, { error: 'payload_too_large' });
          return;
        }
        chunks.push(buffer);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), (_key, value: unknown) => {
          if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite JSON number');
          return value;
        });
      } catch {
        reply(response, 400, { error: 'invalid_json' });
        return;
      }
      const target = join(inbox, name);
      await directory(target);
      const id = randomUUID();
      temporary = join(target, `.${id}.tmp`);
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(payload));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, join(target, `${id}.json`));
      temporary = undefined;
      const dir = await open(target, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
      reply(response, 202, { accepted: true, id });
    } catch {
      if (temporary) await unlink(temporary).catch(() => undefined);
      if (!response.headersSent) reply(response, 500, { error: 'inbox_write_failed' });
      else response.destroy();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      accept();
    });
  });
  return server;
}

async function directory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  if (!(await lstat(path)).isDirectory()) throw new Error('inbox directory must not be a symlink');
}

export async function runServeWebhook(
  options: { dataDir: string; port: number }, io: CliIo,
): Promise<0 | 1> {
  try {
    const server = await startWebhookServer(options.dataDir, options.port);
    const address = server.address();
    io.stdout(`WEBHOOK http://127.0.0.1:${typeof address === 'object' && address ? address.port : options.port}`);
    await new Promise<void>((accept, reject) => {
      const stop = (): void => {
        server.close(error => error ? reject(error) : accept());
        server.closeAllConnections();
      };
      server.once('error', reject);
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      server.once('close', () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      });
    });
    return 0;
  } catch (error) {
    io.stderr(`FAILED [webhook_server] ${error instanceof Error ? error.message : 'receiver failed'}`);
    return 1;
  }
}
