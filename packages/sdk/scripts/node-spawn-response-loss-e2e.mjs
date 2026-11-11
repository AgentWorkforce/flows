#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import {
  chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { createBridgeResponseLossProxy } from './node-spawn-response-loss-proxy.mjs';

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

function assertCommandSpec(spec, label) {
  assert.equal(typeof spec?.command, 'string', `${label}.command is required`);
  assert(isAbsolute(spec.command), `${label}.command must be absolute`);
  assert(Array.isArray(spec.args) && spec.args.every(arg => typeof arg === 'string'),
    `${label}.args must be strings`);
  assert(!spec.args.some(arg => arg === '--service-caller-file' || arg.startsWith('--service-caller-file=')),
    `${label} must use the proxy caller injected by the proof kit`);
}

function commandWithRunId(spec, runId) {
  return {
    command: spec.command,
    args: spec.args.map(arg => arg.replaceAll('{RUN_ID}', runId)),
  };
}

async function runProcess(spec, { cwd, env, logPath, timeoutMs }) {
  const fd = openSync(logPath, 'wx', 0o600);
  const child = spawn(spec.command, spec.args, {
    cwd,
    env,
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  const result = await Promise.race([
    new Promise((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    }),
    delay(timeoutMs, undefined, { ref: false }).then(() => {
      child.kill('SIGKILL');
      throw new Error(`command timed out; see ${logPath}`);
    }),
  ]);
  return { child, result };
}

async function waitForRunId(dataDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let files = [];
    try {
      files = (await readdir(join(dataDir, 'runs'))).filter(file => file.endsWith('.sqlite3'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (files.length === 1) return files[0].slice(0, -'.sqlite3'.length);
    assert(files.length <= 1, 'proof data dir contains more than one run');
    await delay(25);
  }
  throw new Error('timed out waiting for the single proof run id');
}

export async function assertSecretFree(paths) {
  const forbidden = [
    /rsc_[A-Za-z0-9_-]{20,}/,
    /(?:ar|arr|at|br|nt|ot|rk)_(?:live_)?[A-Za-z0-9_-]{8,}/,
    /(?:relay_pa_|sh_fr_)[A-Za-z0-9_-]+/,
    /caller_secret/i,
    /(?:RELAY|AGENT_RELAY|RELAYCAST)_(?:AGENT_TOKEN|API_KEY|WORKSPACE_KEY|NODE_TOKEN|WORKSPACES_JSON)/,
  ];
  for (const path of paths) {
    const text = await readFile(path, 'utf8');
    assert(!forbidden.some(pattern => pattern.test(text)), `${path} contains credential-shaped material`);
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function within(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function packageTreeReceipt(packageDirectory) {
  const hash = createHash('sha256');
  let fileCount = 0;
  const walk = async (directory, prefix = '') => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path, name);
      else if (entry.isFile()) {
        hash.update(name).update('\0').update(await readFile(path)).update('\0');
        fileCount += 1;
      } else {
        throw new Error(`consumer package contains unsupported filesystem entry: ${name}`);
      }
    }
  };
  await walk(packageDirectory);
  return { tree_sha256: hash.digest('hex'), file_count: fileCount };
}

async function installedPackageReceipt(requireFromConsumer, consumerRoot, name) {
  const entryPath = await realpath(requireFromConsumer.resolve(name));
  let directory = dirname(entryPath);
  for (;;) {
    try {
      const manifestPath = join(directory, 'package.json');
      const manifestBytes = await readFile(manifestPath);
      const document = JSON.parse(manifestBytes.toString('utf8'));
      if (document.name === name && typeof document.version === 'string') {
        const packageDirectory = await realpath(directory);
        assert(within(consumerRoot, packageDirectory),
          `${name} must be physically installed beneath consumerRoot`);
        const tree = await packageTreeReceipt(packageDirectory);
        return {
          document,
          entryPath,
          packageDirectory,
          evidence: {
            name,
            version: document.version,
            package_path: relative(consumerRoot, packageDirectory),
            entry_path: relative(consumerRoot, entryPath),
            package_json_sha256: sha256(manifestBytes),
            entry_sha256: sha256(await readFile(entryPath)),
            ...tree,
          },
        };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`could not resolve installed ${name} package from consumerRoot`);
}

export async function resolveConsumerArtifacts(consumerRoot) {
  assert.equal(typeof consumerRoot, 'string', 'consumerRoot is required');
  assert(isAbsolute(consumerRoot), 'consumerRoot must be absolute');
  const exactRoot = await realpath(consumerRoot);
  assert.equal((await stat(exactRoot)).mode & 0o777, 0o700,
    'consumerRoot must be mode 0700');
  const requireFromConsumer = createRequire(pathToFileURL(join(exactRoot, 'package.json')));
  const sdk = await installedPackageReceipt(
    requireFromConsumer, exactRoot, '@relayflows/sdk');
  const coreBridge = await installedPackageReceipt(
    requireFromConsumer, exactRoot, '@agent-relay/core-bridge');
  assert.equal(coreBridge.document.version, '18.1.0',
    'proof kit requires public @agent-relay/core-bridge@18.1.0 in consumerRoot');
  const bin = typeof sdk.document.bin === 'string'
    ? sdk.document.bin : sdk.document.bin?.flows;
  assert.equal(typeof bin, 'string', 'consumer @relayflows/sdk must expose its flows CLI');
  const cliPath = await realpath(resolve(sdk.packageDirectory, bin));
  assert(within(sdk.packageDirectory, cliPath),
    'consumer @relayflows/sdk CLI must stay inside its package');
  const lockPath = join(exactRoot, 'package-lock.json');
  const lockBytes = await readFile(lockPath);
  return {
    root: exactRoot,
    sdkCliPath: cliPath,
    coreBridgeEntryPath: coreBridge.entryPath,
    evidence: {
      consumer_lock_sha256: sha256(lockBytes),
      relayflows_sdk: {
        ...sdk.evidence,
        cli_path: relative(exactRoot, cliPath),
        cli_sha256: sha256(await readFile(cliPath)),
      },
      core_bridge: coreBridge.evidence,
    },
  };
}

export async function assertConsumerCommand(spec, label, artifacts) {
  assertCommandSpec(spec, label);
  assert.equal(await realpath(spec.command), await realpath(process.execPath),
    `${label}.command must be the Node executable running the proof kit`);
  assert(spec.args.length > 0 && isAbsolute(spec.args[0]),
    `${label}.args[0] must be the absolute consumer SDK CLI`);
  assert.equal(await realpath(spec.args[0]), artifacts.sdkCliPath,
    `${label} must launch the exact @relayflows/sdk CLI from consumerRoot`);
}

async function main() {
  const configIndex = process.argv.indexOf('--config');
  assert(configIndex >= 0 && process.argv[configIndex + 1], 'usage: node node-spawn-response-loss-e2e.mjs --config /absolute/config.json');
  const configPath = resolve(process.argv[configIndex + 1]);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  for (const field of [
    'callerFile', 'consumerRoot', 'dataDir', 'evidenceDir', 'homeDir', 'workDir',
  ]) {
    assert.equal(typeof config[field], 'string', `${field} is required`);
    assert(isAbsolute(config[field]), `${field} must be absolute`);
  }
  const consumerArtifacts = await resolveConsumerArtifacts(config.consumerRoot);
  await assertConsumerCommand(config.start, 'start', consumerArtifacts);
  await assertConsumerCommand(config.resume, 'resume', consumerArtifacts);
  assert.equal(config.audit, undefined,
    'audit is built into the proof kit; fixture-supplied audit commands are not accepted');
  assert(config.resume.args.some(arg => arg.includes('{RUN_ID}')), 'resume args must contain {RUN_ID}');
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'timeoutMs must be positive');
  assert.equal((await stat(configPath)).mode & 0o777, 0o600, 'config must be mode 0600');
  await mkdir(config.homeDir, { recursive: true, mode: 0o700 });
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await mkdir(config.evidenceDir, { recursive: true, mode: 0o700 });
  for (const [label, path] of [
    ['homeDir', config.homeDir],
    ['dataDir', config.dataDir],
    ['evidenceDir', config.evidenceDir],
  ]) {
    assert.equal((await stat(path)).mode & 0o777, 0o700, `${label} must be mode 0700`);
  }
  let initialRuns = [];
  try {
    initialRuns = (await readdir(join(config.dataDir, 'runs'))).filter(file => file.endsWith('.sqlite3'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  assert.deepEqual(initialRuns, [], 'proof dataDir must not contain an earlier run');

  const { readCallerDescriptor } = await import(
    pathToFileURL(consumerArtifacts.coreBridgeEntryPath).href
  );
  const descriptor = await readCallerDescriptor(config.callerFile);
  const privateDir = await mkdtemp(join(tmpdir(), 'flows-response-loss-private-'));
  await chmod(privateDir, 0o700);
  const proxySocket = join(privateDir, 'core.sock');
  const proxyCaller = join(privateDir, 'caller.json');
  const callerDocument = JSON.parse(await readFile(config.callerFile, 'utf8'));
  callerDocument.socket = proxySocket;
  await writeFile(proxyCaller, `${JSON.stringify(callerDocument)}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(proxyCaller, 0o600);

  const childEnv = { ...process.env,
    HOME: config.homeDir,
    RELAYFLOW_SERVICE_CALLER_FILE: proxyCaller,
    FLOWS_CLOUD_MIRROR: '0',
    TMPDIR: privateDir,
  };
  for (const name of [
    'AGENT_RELAY_WORKSPACE_KEY',
    'RELAYCAST_WORKSPACE_KEY',
    'RELAY_AGENT_TOKEN',
    'RELAY_API_KEY',
    'RELAY_BROKER_API_KEY',
    'RELAY_NODE_TOKEN',
    'RELAY_WORKSPACE_KEY',
    'RELAY_WORKSPACES_JSON',
    'NODE_OPTIONS',
    'NODE_PATH',
  ]) delete childEnv[name];
  let firstChild;
  const proxy = await createBridgeResponseLossProxy({
    listenSocket: proxySocket,
    upstreamSocket: descriptor.socket,
    onIntercept: () => {
      if (firstChild?.pid) process.kill(firstChild.pid, 'SIGKILL');
    },
  });
  try {
    const startLog = join(config.evidenceDir, 'start.log');
    const startFd = openSync(startLog, 'wx', 0o600);
    firstChild = spawn(config.start.command, config.start.args, {
      cwd: config.workDir,
      env: childEnv,
      stdio: ['ignore', startFd, startFd],
    });
    closeSync(startFd);
    const startExit = new Promise((resolveExit, rejectExit) => {
      firstChild.once('error', rejectExit);
      firstChild.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    await Promise.race([
      proxy.intercepted,
      delay(timeoutMs, undefined, { ref: false })
        .then(() => { throw new Error(`spawn reply was not intercepted; see ${startLog}`); }),
    ]);
    const firstResult = await startExit;
    assert.equal(firstResult.signal, 'SIGKILL', 'initial Flows process must die by SIGKILL');
    const runId = await waitForRunId(config.dataDir, timeoutMs);

    const resumeSpec = commandWithRunId(config.resume, runId);
    const resumeLog1 = join(config.evidenceDir, 'resume-1.log');
    const resumeLog2 = join(config.evidenceDir, 'resume-2.log');
    const [left, right] = await Promise.all([
      runProcess(resumeSpec, {
        cwd: config.workDir, env: childEnv,
        logPath: resumeLog1, timeoutMs,
      }),
      runProcess(resumeSpec, {
        cwd: config.workDir, env: childEnv,
        logPath: resumeLog2, timeoutMs,
      }),
    ]);
    const resumeResults = [left.result, right.result];
    const replayPids = [left.child.pid, right.child.pid];
    assert(replayPids.every(pid => Number.isSafeInteger(pid) && pid > 0),
      'both replay process ids must be available');
    assert.equal(new Set(replayPids).size, 2,
      'the replay race must use two independent process generations');
    assert(!replayPids.includes(firstChild.pid),
      'neither replay may reuse the killed foreground process generation');
    assert(resumeResults.some(result => result.code === 0),
      'at least one raced resume must complete successfully');
    assert(resumeResults.every(result => result.signal === null),
      'neither raced resume may die by signal');

    const proxyStatsPath = join(privateDir, 'proxy-stats.json');
    const processEvidencePath = join(privateDir, 'process-evidence.json');
    await writeFile(proxyStatsPath, `${JSON.stringify(proxy.stats)}\n`, { mode: 0o600, flag: 'wx' });
    await writeFile(processEvidencePath, `${JSON.stringify({
      initial: { pid: firstChild.pid, ...firstResult },
      replays: [
        { pid: left.child.pid, ...left.result },
        { pid: right.child.pid, ...right.result },
      ],
    })}\n`, { mode: 0o600, flag: 'wx' });
    const auditSpec = {
      command: process.execPath,
      args: [
        fileURLToPath(new URL('./node-spawn-response-loss-audit.mjs', import.meta.url)),
        '--run', runId,
        '--data-dir', config.dataDir,
        '--proxy-stats', proxyStatsPath,
        '--process-evidence', processEvidencePath,
        '--json',
      ],
    };
    const auditLog = join(config.evidenceDir, 'audit.stderr.log');
    const fd = openSync(auditLog, 'wx', 0o600);
    const auditChild = spawn(auditSpec.command, auditSpec.args, {
      cwd: config.workDir,
      env: childEnv,
      stdio: ['ignore', 'pipe', fd],
    });
    closeSync(fd);
    let auditStdout = '';
    auditChild.stdout.on('data', chunk => { auditStdout += String(chunk); });
    const auditExit = await Promise.race([
      new Promise((resolveExit, rejectExit) => {
        auditChild.once('error', rejectExit);
        auditChild.once('exit', (code, signal) => resolveExit({ code, signal }));
      }),
      delay(timeoutMs, undefined, { ref: false }).then(() => {
        auditChild.kill('SIGKILL');
        throw new Error(`audit command timed out; see ${auditLog}`);
      }),
    ]);
    assert.deepEqual(auditExit, { code: 0, signal: null }, `audit command failed; see ${auditLog}`);
    const audit = JSON.parse(auditStdout);
    await assertSecretFree([startLog, resumeLog1, resumeLog2, auditLog]);
    const evidence = {
      ...audit,
      run_id: runId,
      consumer_artifacts: consumerArtifacts.evidence,
    };
    const evidencePath = join(config.evidenceDir, 'response-loss-proof.json');
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ ok: true, evidence: evidencePath, run_id: runId }));
  } finally {
    await proxy.close();
    await rm(privateDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
