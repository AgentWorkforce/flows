import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Agent } from 'undici';
import type { McpServerConfig } from './spec.js';
import { McpStdioTransport } from './mcp-stdio.js';

export type McpDiagnostic = 'spawn_failed' | 'handshake_timeout' | 'handshake_rejected' | 'mcp_disconnected';
export class McpError extends Error {
  constructor(readonly code: McpDiagnostic) { super(code); }
}
export interface McpSession {
  listTools(): Promise<string[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/** One bounded session, never a reconnect/retry loop. Protocol and framing are
 * supplied by the official SDK; this adapter owns resource lifetimes. */
export async function openMcpSession(config: McpServerConfig, timeoutMs: number): Promise<McpSession> {
  const client = new Client({ name: 'relayflows', version: '1.0.0' });
  const controller = new AbortController();
  let dispatcher: Agent | undefined;
  let transport: Transport;
  if ('command' in config) {
    transport = new McpStdioTransport(config);
  } else {
    dispatcher = new Agent();
    transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 0, maxReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
      fetch: (url, init) => fetch(url, {
        ...init, redirect: 'error',
        signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]),
        dispatcher,
      } as RequestInit),
    });
  }
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    controller.abort();
    try { await client.close(); } finally {
      await transport.close();
      await dispatcher?.destroy();
    }
  })();
  let phase: 'handshake' | 'call' = 'handshake';
  let failure: McpError | undefined;
  let rejectTransport!: (error: McpError) => void;
  const broken = new Promise<never>((_, reject) => { rejectTransport = reject; });
  void broken.catch(() => undefined);
  const fail = (code: McpDiagnostic): void => {
    failure ??= new McpError(code);
    rejectTransport(failure);
  };
  client.onerror = error => {
    const code = (error as NodeJS.ErrnoException).code;
    fail(phase === 'call' ? 'mcp_disconnected'
      : code === 'ENOENT' || code === 'EACCES' ? 'spawn_failed' : 'handshake_rejected');
  };
  client.onclose = () => {
    if (!closing) fail(phase === 'call' ? 'mcp_disconnected' : 'handshake_rejected');
  };
  const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (failure) throw failure;
      return await Promise.race([work(), broken, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new McpError(phase === 'call' ? 'mcp_disconnected' : 'handshake_timeout')), timeoutMs);
      })]);
    } catch (error) {
      await close();
      throw error instanceof McpError ? error : new McpError(phase === 'call' ? 'mcp_disconnected' : 'handshake_rejected');
    } finally { clearTimeout(timer); }
  };
  await bounded(() => client.connect(transport));
  return {
    listTools: () => bounded(async () => {
      const names: string[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor === undefined ? {} : { cursor });
        names.push(...page.tools.map(tool => tool.name));
        cursor = page.nextCursor;
        if (cursor !== undefined && cursors.has(cursor)) throw new McpError('handshake_rejected');
        if (cursor !== undefined) cursors.add(cursor);
      } while (cursor !== undefined);
      return [...new Set(names)];
    }),
    callTool: (name, args) => {
      phase = 'call';
      return bounded(() => client.callTool({ name, arguments: args as Record<string, unknown> }));
    },
    close,
  };
}
