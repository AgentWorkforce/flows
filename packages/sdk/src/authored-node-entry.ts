import { createHash } from 'node:crypto';
import { readFileSync, writeSync } from 'node:fs';
import { JournalClient } from './journal-client.js';
import { executeAuthoredFlow } from './authored-flow-executor.js';
import { loadPinnedAuthoredSource } from './authored-source-authority.js';
import { assertAuthoredNodeVersion } from './authored-runtime-capability.js';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';
import type { AuthoredRootMetadata } from './authored-root.js';

const send = (message: unknown): void => { writeSync(3, JSON.stringify(message) + '\n'); };
const hash = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const controller = new AbortController();
let finished = false;
const abort = (): void => {
  controller.abort();
  setTimeout(() => process.exit(1), 2000).unref();
};
process.on('SIGINT', abort); process.on('SIGTERM', abort);
// The parent owns the root lease. Do not continue authored effects after it dies.
process.stdin.on('end', () => { if (!finished) process.exit(1); });
process.stdin.on('error', () => process.exit(1));
let client: JournalClient | undefined;
try {
  assertAuthoredNodeVersion();
  send({ type: 'ready', runtime: { kind: 'node', version: process.versions.node,
    executableSha256: hash(process.execPath), payloadSha256: hash(process.argv[1]!) } });
  const request = await new Promise<{ metadata: AuthoredRootMetadata; socketPath: string;
    rootRunId: string; dataDir: string; localAgentStream?: string }>((resolve, reject) => {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    const onData = (chunk: string): void => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { reject(new Error('authored runtime request exceeded limit')); return; }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      process.stdin.off('data', onData);
      try { resolve(JSON.parse(buffer.slice(0, end))); } catch { reject(new Error('invalid authored runtime request')); }
    };
    process.stdin.on('data', onData);
  });
  controller.signal.throwIfAborted();
  const loaded = await loadPinnedAuthoredSource(request.metadata);
  if (request.localAgentStream !== request.metadata.localAgentStream) throw new Error('authored root local agent surface mismatch');
  client = new JournalClient(request.socketPath);
  await client.connect(); await client.hello('flows-authored-node');
  const result = await executeAuthoredFlow(loaded.handle, client,
    request.metadata.inputPresent ? request.metadata.input : undefined, {
      getDefinition: loaded.getDefinition, dataDir: request.dataDir,
      flowPath: request.metadata.flowPath, rootRunId: request.rootRunId,
      localAgentStream: request.localAgentStream, signal: controller.signal,
      onProgress: event => send({ type: 'progress', event }),
      onWait: event => send({ type: 'wait', event }),
    });
  send({ type: 'result', result });
} catch (error) {
  send({ type: 'error', message: error instanceof Error ? error.message : 'authored body failed',
    ...(error instanceof AuthoredFlowExecutionError ? { code: error.code,
      completionReason: error.completionReason, runId: error.runId } : {}) });
  process.exitCode = 1;
} finally {
  finished = true; client?.close(); process.stdin.destroy();
  process.off('SIGINT', abort); process.off('SIGTERM', abort);
}
