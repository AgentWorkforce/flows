import { spawnSync } from 'node:child_process';
import { cpus, platform, release } from 'node:os';
import { resolve } from 'node:path';

export function collectProvenance(rootDir, execute = spawnSync) {
  const gitCommit = commandResult(execute, 'git', ['rev-parse', 'HEAD'], rootDir);
  const gitStatus = commandResult(execute, 'git', ['status', '--porcelain=v1'], rootDir);
  const gitRoot = commandResult(execute, 'git', ['rev-parse', '--show-toplevel'], rootDir);
  const cpu = cpus();
  return {
    source: {
      commit: gitCommit.ok ? gitCommit.stdout : null,
      root: gitRoot.ok ? resolve(gitRoot.stdout) : rootDir,
      dirty: !gitCommit.ok || !gitStatus.ok || !gitRoot.ok || gitStatus.stdout.length > 0,
      statusAvailable: gitStatus.ok,
      statusPorcelain: gitStatus.stdout,
    },
    runtime: {
      node: process.version,
      nodePath: process.execPath,
      rustc: commandText(execute, 'rustc', ['--version'], rootDir) || null,
      cargo: commandText(execute, resolve(rootDir, 'ops/cargo.sh'), ['--version'], rootDir) || null,
    },
    host: {
      platform: platform(),
      release: release(),
      arch: process.arch,
      cpuModel: cpu[0]?.model ?? null,
      logicalCpus: cpu.length,
    },
  };
}

function commandText(execute, file, args, cwd) {
  const result = execute(file, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) return '';
  return text(result.stdout).trim();
}

function commandResult(execute, file, args, cwd) {
  const result = execute(file, args, { cwd, encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: result.status === 0 ? text(result.stdout).trim() : '',
  };
}

function text(value) {
  if (value === undefined || value === null) return '';
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}
