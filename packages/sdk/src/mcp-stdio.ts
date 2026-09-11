import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfig } from './spec.js';

/** SDK framing with parent-owned spawning/cleanup: SDK's stdio transport
 * unconditionally inherits HOME/PATH/etc. and cannot enforce our env contract. */
export class McpStdioTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  private child?: ChildProcessWithoutNullStreams;
  private readonly buffer = new ReadBuffer({ maxBufferSize: 1_048_576 });
  private closed?: Promise<void>;
  private closing?: Promise<void>;
  constructor(private readonly config: Extract<McpServerConfig, { command: string }>) {}

  async start(): Promise<void> {
    const env: NodeJS.ProcessEnv = Object.create(null);
    for (const name of this.config.env ?? []) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    const child = this.child = spawn(this.config.command, this.config.args ?? [], {
      env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.closed = new Promise(resolve => child.once('close', () => resolve()));
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.closing) return;
      try {
        this.buffer.append(chunk);
        let message: JSONRPCMessage | null;
        while ((message = this.buffer.readMessage()) !== null) this.onmessage?.(message);
      } catch (error) { this.onerror?.(error as Error); }
    });
    child.stdout.once('end', () => this.onclose?.());
    child.stdout.on('error', error => this.onerror?.(error));
    child.stdin.on('error', error => this.onerror?.(error));
    child.on('error', error => this.onerror?.(error));
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.child || this.closing) return reject(new Error('MCP transport closed'));
      this.child.stdin.write(serializeMessage(message), error => error ? reject(error) : resolve());
    });
  }

  close(): Promise<void> {
    return this.closing ??= this.stop();
  }

  private async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    child.kill('SIGTERM');
    // Drain pipes until close or our own deadline; a descendant may keep a
    // pipe open even after the direct child has exited.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.closed, new Promise<void>(resolve => {
      timer = setTimeout(resolve, 1000);
    })]);
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
    }
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    this.buffer.clear();
    this.onclose?.();
  }
}
