import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { flow } from '@relayflows/surface';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { preflight, type PreflightProbes } from '../src/preflight.js';
import { openMcpSession } from '../src/mcp-client.js';
import { parseMcpConfig } from '../src/mcp-config.js';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { buildMcpProxy } from '../src/authored-mcp.js';
import { JournalClient } from '../src/journal-client.js';
import { socketPathFor } from '../src/daemon-connection.js';
import type { McpServerConfig } from '../src/spec.js';

const root = resolve('../..');
const mock = (name: string) => join(root, 'testdata/mock-mcp-server', `${name}.mjs`);
const spec = { version: '0.1.0' as const, name: 'mcp-check', steps: [{ id: 'one', type: 'deterministic' as const, command: ':' }] };
const probes: PreflightProbes = { command: () => true, cli: () => ({ exists: true, authenticated: true }), executor: () => true };
const roots: string[] = [];
function temp(): string { const path = mkdtempSync(join(tmpdir(), 'flows-mcp-')); roots.push(path); return path; }
function config(name = 'ok', marker?: string): McpServerConfig {
  return { command: process.execPath, args: [mock(name), ...(marker ? [marker] : [])] };
}
function fixture(mcp: unknown, body = "await f.mcp.foo.echo({hello:'world'}); f.done('success');") {
  const directory = temp();
  symlinkSync(resolve('node_modules'), join(directory, 'node_modules'));
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  writeFileSync(join(directory, 'flows.json'), JSON.stringify({ mcp }));
  const path = join(directory, 'example.flow.ts');
  writeFileSync(path, `import {flow} from '@relayflows/surface'; export default flow('mcp-test', {tools:{mcp:['foo']}}, async f => {${body}});`);
  return { directory, path };
}
function gone(marker: string) {
  const { pid } = JSON.parse(readFileSync(marker, 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();
}
afterEach(() => { vi.unstubAllEnvs(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('MCP preflight and transports', () => {
  it('collects undeclared servers and CLI refusals before any probe or spawn', async () => {
    const marker = join(temp(), 'started');
    const probe = vi.fn(() => { throw new Error('must not probe'); });
    const result = await preflight({ ...spec, steps: [...spec.steps, { id: 'agent', type: 'agent', instruction: 'hi' }] }, {
      mcpServers: ['foo', 'missing'], mcp: { foo: config('ok', marker) },
      probes: { command: probe, cli: probe, executor: probe },
    });
    expect(result.diagnostics.map(d => d.kind)).toEqual(['mcp_undeclared_server', 'cli_unresolved']);
    expect(probe).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
  });
  it('flows check refuses an undeclared server with exit 2 and no daemon', () => {
    const f = fixture(undefined);
    const dataDir = join(f.directory, 'data');
    const result = spawnSync(process.execPath, ['dist/cli-executable.js', 'check', f.path, '--json'], {
      encoding: 'utf8', env: { ...process.env, RELAYFLOWS_DATA_DIR: dataDir }, timeout: 15000,
    });
    expect(result.status, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout).diagnostics).toContainEqual(expect.objectContaining({ kind: 'mcp_undeclared_server' }));
    expect(existsSync(dataDir)).toBe(false);
  });
  it('refuses a server that exits, reaping its PID before returning', async () => {
    const marker = join(temp(), 'pid');
    const result = await preflight(spec, { mcpServers: ['foo'], mcp: { foo: config('refuse', marker) }, probes });
    expect(result).toMatchObject({ ok: false, diagnostics: expect.arrayContaining([
      expect.objectContaining({ kind: 'mcp_unreachable', cause: 'handshake_rejected' }),
    ]) });
    gone(marker);
  });
  it('flows check reports a refusing server and leaves no PID', () => {
    const marker = join(temp(), 'pid');
    const f = fixture({ foo: config('refuse', marker) });
    const result = spawnSync(process.execPath, ['dist/cli-executable.js', 'check', f.path, '--json'], { encoding: 'utf8', timeout: 15000 });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).diagnostics).toContainEqual(expect.objectContaining({ kind: 'mcp_unreachable', cause: 'handshake_rejected' }));
    gone(marker);
  });
  it('undeclared Ctx access throws before any journal write or configured server spawn', async () => {
    const marker = join(temp(), 'pid');
    const f = fixture({ foo: config('refuse', marker) });
    const client = new JournalClient('/must-not-connect');
    const start = vi.spyOn(client, 'runStart');
    const handle = flow('undeclared', async f => { await f.mcp.notdeclared!.echo!({}); f.done('success'); });
    await expect(executeAuthoredFlow(handle, client, undefined, { flowPath: f.path })).rejects.toBeInstanceOf(TypeError);
    expect(start).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
  });
  it('captures inventory, reaps the PID, and passes only declared env names', async () => {
    const marker = join(temp(), 'pid');
    vi.stubEnv('MOCK_MCP_TOKEN', 'allowed'); vi.stubEnv('MOCK_MCP_SECRET', 'hidden'); vi.stubEnv('RELAYFLOW_MODEL', 'hidden');
    const result = await preflight(spec, { mcpServers: ['foo'], mcp: { foo: { ...config('ok', marker), env: ['MOCK_MCP_TOKEN'] } }, probes });
    expect(result).toMatchObject({ ok: true, mcpTools: { foo: ['echo', 'add'] } });
    const env = JSON.parse(readFileSync(marker, 'utf8')).env;
    // libuv injects this OS encoding setting on macOS even with env: {}.
    if (process.platform === 'darwin') delete env.__CF_USER_TEXT_ENCODING;
    expect(env).toEqual({ MOCK_MCP_TOKEN: 'allowed' });
    gone(marker);
  });
  it('classifies a missing executable', async () => {
    await expect(openMcpSession({ command: '/nonexistent-mcp-executable' }, 100)).rejects.toMatchObject({ code: 'spawn_failed' });
  });
  it('kills a SIGTERM-resistant silent child after a parent-owned handshake deadline', async () => {
    const marker = join(temp(), 'pid');
    const source = `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid})); process.on('SIGTERM',()=>{}); setInterval(()=>{},100);`;
    await expect(openMcpSession({ command: process.execPath, args: ['-e', source] }, 300)).rejects.toMatchObject({ code: 'handshake_timeout' });
    gone(marker);
  });
  it.skipIf(process.platform === 'win32').each(['inherit', 'ignore'] as const)('reaps a SIGTERM-resistant descendant with %s stdio before cleanup finishes', async stdio => {
    const directory = temp();
    const parent = join(directory, 'parent');
    const child = join(directory, 'child');
    const wrapper = join(directory, 'wrapper.mjs');
    const source = `process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(child)},JSON.stringify({pid:process.pid})); setInterval(()=>{},100);`;
    writeFileSync(wrapper, `import {spawn} from 'node:child_process';
import {writeFileSync,existsSync} from 'node:fs';
writeFileSync(${JSON.stringify(parent)},JSON.stringify({pid:process.pid}));
spawn(process.execPath,['-e',${JSON.stringify(source)}],{stdio:${JSON.stringify(stdio)}});
while(!existsSync(${JSON.stringify(child)})) await new Promise(r=>setTimeout(r,10));
${stdio === 'inherit' ? `await import(${JSON.stringify(pathToFileURL(mock('ok')).href)});` : 'setInterval(()=>{},100);'}
`);
    try {
      if (stdio === 'inherit') {
        const session = await openMcpSession({ command: process.execPath, args: [wrapper] }, 1000);
        await session.close();
      } else {
        await expect(openMcpSession({ command: process.execPath, args: [wrapper] }, 1000)).rejects.toMatchObject({ code: 'handshake_timeout' });
      }
      gone(parent);
      await vi.waitFor(() => gone(child));
    } finally {
      for (const marker of [parent, child]) {
        if (!existsSync(marker)) continue;
        try { process.kill(JSON.parse(readFileSync(marker, 'utf8')).pid, 'SIGKILL'); } catch {}
      }
    }
  });
  it('classifies a mid-call stdout drop without retry and closes the child', async () => {
    const marker = join(temp(), 'pid');
    const session = await openMcpSession(config('drop', marker), 1000);
    try { await expect(session.callTool('echo', {})).rejects.toMatchObject({ code: 'mcp_disconnected' }); }
    finally { await session.close(); }
    gone(marker);
  });
  it.each([
    null, [], { foo: {} }, { foo: { command: 'node', url: 'http://localhost' } },
    { foo: { command: 'node', secret: 'no' } }, { foo: { command: 'node', env: { TOKEN: 'value' } } },
    { foo: { command: 'node', env: ['KEY=value'] } }, { foo: { command: 'node', args: [3] } },
    { foo: { url: 'file:///tmp/mcp' } }, { foo: { url: 'http://localhost', headers: { token: 1 } } },
  ])('fails closed on malformed config %j', value => expect(() => parseMcpConfig(value)).toThrow());
  it('reports malformed connection configuration as config_invalid', () => {
    const f = fixture({ foo: { command: 'node', url: 'http://localhost' } });
    const result = spawnSync(process.execPath, ['dist/cli-executable.js', 'check', f.path, '--json'], { encoding: 'utf8', timeout: 15000 });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).diagnostics[0].kind).toBe('config_invalid');
  });
  it('returns undefined for undeclared servers before any journal write', () => {
    const invoke = vi.fn();
    const mcp = buildMcpProxy({ foo: ['echo', 'add'] }, invoke);
    expect(() => mcp.notdeclared!.echo!({})).toThrow(TypeError);
    expect(Object.keys(mcp)).toEqual(['foo']);
    expect(Object.keys(mcp.foo!)).toEqual(['echo', 'add']);
    expect(mcp.constructor).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('MCP HTTP transport', () => {
  let server: Server;
  const sockets = new Set<import('node:net').Socket>();
  let url: string;
  const received: import('node:http').IncomingHttpHeaders[] = [];
  let refuse = false;
  let hang = false;
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      received.push(req.headers);
      if (hang) return;
      if (refuse) { res.writeHead(503).end(); return; }
      if (req.method === 'GET') { res.writeHead(405).end(); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString());
      if (request.id === undefined) { res.writeHead(202).end(); return; }
      const result = request.method === 'initialize'
        ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'http', version: '1' } }
        : request.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: JSON.stringify(request.params.arguments) }] };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  it('initializes and calls HTTP with declared headers and closes all sockets', async () => {
    const result = await preflight(spec, { mcpServers: ['foo'], mcp: { foo: { url, headers: { 'x-token': 'declared' } } }, probes });
    expect(result).toMatchObject({ ok: true, mcpTools: { foo: ['echo'] } });
    await vi.waitFor(() => expect(sockets.size).toBe(0));
    expect(received.every(h => h['x-token'] === 'declared' && h.authorization === undefined)).toBe(true);
    const session = await openMcpSession({ url }, 1000);
    try { expect(await session.callTool('echo', { foo: 1 })).toMatchObject({ content: [{ text: '{"foo":1}' }] }); }
    finally { await session.close(); }
    await vi.waitFor(() => expect(sockets.size).toBe(0));
  });
  it('aborts a stalled HTTP initialization at the parent deadline', async () => {
    hang = true;
    try { await expect(openMcpSession({ url }, 100)).rejects.toMatchObject({ code: 'handshake_timeout' }); }
    finally { hang = false; }
    await vi.waitFor(() => expect(sockets.size).toBe(0));
  });
  it('classifies non-2xx and closes its socket', async () => {
    refuse = true;
    try { await expect(openMcpSession({ url }, 1000)).rejects.toMatchObject({ code: 'handshake_rejected' }); }
    finally { refuse = false; }
    await vi.waitFor(() => expect(sockets.size).toBe(0));
  });
});

describe('authored MCP effects against the real kernel', () => {
  let daemon: ChildProcess;
  let directory: string;
  let journal: JournalClient;
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'flows-mcp-daemon-'));
    daemon = spawn(process.env.RELAYFLOWD_BIN ?? join(root, 'kernel/target/release/relayflowd'), ['--data-dir', directory, 'serve'], { stdio: 'ignore' });
    journal = new JournalClient(socketPathFor(directory));
    for (let n = 0; ; n++) {
      try { await journal.connect(); await journal.hello('mcp-test'); break; }
      catch (error) { if (n > 100) throw error; await delay(25); }
    }
  });
  afterAll(async () => {
    journal?.close();
    if (daemon?.exitCode === null) { const exited = new Promise<void>(resolve => daemon.once('exit', () => resolve())); daemon.kill(); await exited; }
    rmSync(directory, { recursive: true, force: true });
  });
  it('journals one MCP receipt per call with args, result, stable logical key, and a confirmed effect', async () => {
    const log = join(temp(), 'calls');
    const f = fixture({ foo: { command: process.execPath, args: [mock('ok'), '', log] }, hidden: config('refuse') });
    const handle = flow('mcp-ok', { tools: { mcp: ['foo'] } }, async f => {
      expect(await f.mcp.foo!.echo!({ foo: 1 })).toMatchObject({ structuredContent: { foo: 1 } });
      const args = { foo: 2 };
      const call = f.mcp.foo!.echo!(args);
      args.foo = 900;
      await call;
      f.done('success');
    });
    const result = await executeAuthoredFlow(handle, journal, undefined, { flowPath: f.path });
    expect(result.journalSteps).toHaveLength(3);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter(c => c.method === 'initialize')).toHaveLength(3);
    expect(calls.filter(c => c.method === 'tools/list')).toHaveLength(1);
    expect(calls.filter(c => c.method === 'tools/call')).toHaveLength(2);
    for (const pid of new Set(calls.map(c => c.pid))) expect(() => process.kill(pid, 0)).toThrow();
    for (const [i, step] of result.journalSteps.slice(0, 2).entries()) {
      const entries = (await journal.journalRead(step.runId, 1)).entries as any[];
      const completed = entries.filter(e => e.entry_type === 'step.completed');
      expect(completed).toHaveLength(1);
      const args = { foo: i + 1 };
      expect(completed[0].payload).toMatchObject({ completionReason: 'success', output: {
        type: 'mcp', input: args, output: { structuredContent: args },
        idempotencyKey: `mcp:foo:echo:${createHash('sha256').update(JSON.stringify(args)).digest('hex')}`,
      } });
      expect(entries.filter(e => e.entry_type === 'effect.recorded')).toHaveLength(1);
      expect(entries.filter(e => e.entry_type === 'effect.confirmed')).toHaveLength(1);
    }
  });
  it('reports a dropped tool connection as a failed CLI run', () => {
    const f = fixture({ foo: config('drop') });
    const result = spawnSync(process.execPath, ['dist/cli-executable.js', 'run', f.path,
      '--input', '{}', '--data-dir', directory, '--no-spawn', '--no-observer-link', '--json'], { encoding: 'utf8', timeout: 15000 });
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'failed', completionReason: 'step_failed', diagnostics: [
      { kind: 'step_failed', message: expect.stringContaining('mcp_disconnected') },
    ] });
  });
  it.each([['drop', 'echo', 'mcp_disconnected'], ['ok', 'absent', 'mcp_unknown_tool']])('journals %s/%s failure as worker_error with diagnostic %s', async (variant, tool, diagnostic) => {
    const f = fixture({ foo: config(variant) });
    const handle = flow('mcp-failure', { tools: { mcp: ['foo'] } }, async f => { await f.mcp.foo![tool]!({}); f.done('success'); });
    let failure: any;
    try { await executeAuthoredFlow(handle, journal, undefined, { flowPath: f.path }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'step_failed', completionReason: 'worker_error', message: expect.stringContaining(diagnostic) });
    const entries = (await journal.journalRead(failure.runId, 1)).entries as any[];
    expect(entries.find(e => e.entry_type === 'step.completed').payload).toMatchObject({ completionReason: 'worker_error', trajectory_tail: { type: 'mcp', diagnostic } });
    expect(await journal.runGet(failure.runId)).toMatchObject({ status: 'failed' });
  });
});
