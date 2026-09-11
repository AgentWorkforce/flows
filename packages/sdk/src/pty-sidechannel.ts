import { createServer, type Socket } from 'node:net';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface SidechannelContext {
  dataDir: string;
  runId: string;
  stepId: string;
  onReady?: (path: string) => void;
  onDrive: () => void;
}

export function ptySocketPath(context: Pick<SidechannelContext, 'dataDir' | 'runId' | 'stepId'>): string {
  for (const id of [context.runId, context.stepId]) {
    if (!id || id === '.' || id === '..' || /[/\\\0]/.test(id)) throw new Error('Invalid sidechannel path component');
  }
  return join(resolve(context.dataDir), 'runs', context.runId, 'steps', context.stepId, 'pty.sock');
}

/** Best-effort live bytes. Slow peers are dropped; they never pause execution. */
export async function openSidechannel(
  context: SidechannelContext,
  input: (bytes: Buffer) => boolean | Promise<boolean>,
  canDrive: () => boolean = () => true,
) {
  const peers = new Map<Socket, boolean>();
  let closed = false;
  const server = createServer(socket => {
    if (peers.size >= 16) { socket.destroy(); return; }
    peers.set(socket, false);
    let hello = Buffer.alloc(0);
    let mode: string | undefined;
    socket.setTimeout(2_000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('close', () => peers.delete(socket));
    socket.on('data', (bytes: Buffer) => {
      if (mode === undefined) {
        hello = Buffer.concat([hello, bytes]);
        const end = hello.indexOf(10);
        if (end < 0) { if (hello.length > 32) socket.destroy(); return; }
        const line = hello.subarray(0, end).toString('utf8');
        if (!['HELLO view', 'HELLO drive', 'HELLO passthrough'].includes(line)) { socket.destroy(); return; }
        mode = line.slice(6);
        if (mode === 'drive' && !canDrive()) { socket.destroy(); return; }
        socket.setTimeout(0);
        peers.set(socket, true);
        // Passthrough is a passive raw-byte view in this initial slice.
        if (mode === 'drive') context.onDrive();
        bytes = hello.subarray(end + 1);
        hello = Buffer.alloc(0);
      }
      if (mode === 'drive' && bytes.length > 0) {
        socket.pause();
        void Promise.resolve().then(() => input(bytes)).then(accepted => {
          if (!accepted) socket.destroy();
          else if (!socket.destroyed) socket.resume();
        }, () => socket.destroy());
      }
    });
  });
  server.on('error', () => { for (const peer of peers.keys()) peer.destroy(); });
  try {
    const path = ptySocketPath(context);
    // Restrict traversal as well as socket access to the worker's OS user.
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => { server.off('error', reject); resolve(); });
    });
    await chmod(path, 0o600);
    context.onReady?.(path);
  } catch {
    // Never unlink a pre-existing socket: it may belong to a live attempt.
    if (server.listening) server.close();
    return undefined;
  }
  return {
    publish(bytes: Buffer) {
      if (closed) return;
      for (const [peer, ready] of peers) {
        if (ready && !peer.write(bytes)) peer.destroy();
      }
    },
    close() {
      if (closed) return;
      closed = true;
      for (const peer of peers.keys()) peer.destroy();
      server.close();
    },
  };
}
