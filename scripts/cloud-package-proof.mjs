#!/usr/bin/env node
// Exercise the packed npm artifact in a fresh project against a local HTTP
// contract server. This proves packaging/dispatch, not hosted execution.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = await mkdtemp(join(tmpdir(), 'flows-cloud-package-'));
let requests = 0;
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(req.url, '/api/v1/workflows/run');
  assert.equal(req.headers.authorization, 'Bearer local-contract-token');
  assert.equal(body.relayflowVersion, 'v2');
  assert.equal(body.fileType, 'yaml');
  assert.equal(JSON.parse(body.workflow).name, 'cloud-gates');
  requests++;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ runId: `contract-${requests}`, status: 'pending' }));
});
try {
  await run('npm', ['run', 'build'], join(root, 'packages/sdk'));
  await writeFile(join(project, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const packed = await run('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', project], join(root, 'packages/sdk'));
  const archive = packed.stdout.trim();
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(project, archive)], project);
  await writeFile(join(project, 'flow.yaml'), await readFile(join(root, 'examples/cloud-gates/cloud-gates.flow.yaml')));
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const env = {
    ...process.env,
    FLOWS_CLOUD_URL: `http://127.0.0.1:${server.address().port}`,
    FLOWS_CLOUD_TOKEN: 'local-contract-token',
    FLOWS_NO_SPAWN: '1',
  };
  const cli = await run('npm', ['exec', '--no', '--', 'flows', 'run', '--cloud', '--json', 'flow.yaml'], project, env);
  assert.equal(JSON.parse(cli.stdout).status, 'pending');
  const sdk = await run(process.execPath, ['--input-type=module', '-e',
    "import { runInCloud } from '@relayflows/sdk'; console.log(JSON.stringify(await runInCloud({path:'flow.yaml'})));"], project, env);
  assert.equal(JSON.parse(sdk.stdout).status, 'pending');
  assert.equal(requests, 2);
  console.log('PACKAGED_CLOUD_CONTRACT_OK: CLI + SDK dispatched v2; local HTTP server only, no hosted run claimed.');
} finally {
  server.closeAllConnections();
  await new Promise(resolveClose => server.close(resolveClose));
  await rm(project, { recursive: true, force: true });
}

function run(command, args, cwd, env = process.env) {
  console.log(`$ ${[command, ...args].map(arg => JSON.stringify(arg)).join(' ')}`);
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => {
      process.stdout.write(stdout);
      process.stdout.write(stderr);
      if (code !== 0) reject(new Error(`Command exited ${code}`));
      else resolveRun({ stdout, stderr });
    });
  });
}
