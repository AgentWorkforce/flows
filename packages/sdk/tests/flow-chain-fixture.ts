import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { JournalClient } from '../src/journal-client.js';
import { socketPathFor } from '../src/daemon-connection.js';

export function chainFixture(output = '{"message":"hello from llm"}') {
  const root = mkdtempSync(join(tmpdir(), 'flows-chain-'));
  const data = join(root, 'data');
  const wrapper = join(root, 'adapter.mjs');
  const calls = join(root, 'calls.jsonl');
  const flowPath = join(root, 'chain.flow.ts');
  const binary = process.env.RELAYFLOWD_BIN ?? join(JSON.parse(execFileSync('sh', [
    resolve('../../ops/cargo.sh'), 'metadata', '--format-version=1', '--no-deps', '--offline',
  ], { cwd: resolve('../../kernel'), encoding: 'utf8' })).target_directory, 'debug/relayflowd');
  writeFileSync(wrapper, `#!/usr/bin/env node
import { receiveWrapperRequest } from ${JSON.stringify(resolve('../../testdata/preflight/wrapper-session.mjs'))};
import { appendFileSync } from 'node:fs';
if (process.argv[2] === 'auth') process.exit(0);
const request = await receiveWrapperRequest();
if (request) {
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify(request) + '\\n');
  process.stdout.write(${JSON.stringify(output)});
}
`);
  chmodSync(wrapper, 0o755);
  writeFileSync(join(root, 'flows.json'), JSON.stringify({ cli: wrapper, models: ['test-model'] }));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
  let daemon: ChildProcess | undefined;
  let client: JournalClient | undefined;
  return {
    root, data, wrapper, calls, flowPath, binary,
    requests: () => readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
    invoke: (...args: string[]) => spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], {
      cwd: root, encoding: 'utf8', timeout: 30_000, env: { ...process.env, RELAYFLOWD_BIN: binary },
    }),
    async connect() {
      daemon = spawn(binary, ['--data-dir', data, 'serve'], { stdio: 'ignore' });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        client = new JournalClient(socketPathFor(data));
        try {
          await client.connect();
          await client.hello('chain-test');
          return client;
        } catch { client.close(); await new Promise(resolve => setTimeout(resolve, 20)); }
      }
      throw new Error('chain fixture daemon failed to start');
    },
    async close() {
      client?.close();
      if (daemon !== undefined && daemon.exitCode === null) {
        const exited = new Promise<void>(resolve => daemon!.once('exit', () => resolve()));
        daemon.kill('SIGTERM');
        await exited;
      }
      if (daemon === undefined && existsSync(join(data, 'connection.json'))) {
        const { pid } = JSON.parse(readFileSync(join(data, 'connection.json'), 'utf8'));
        try { process.kill(pid, 'SIGTERM'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function shellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
