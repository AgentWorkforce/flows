#!/usr/bin/env node
// A stand-in for `relayflowd serve`, implementing the daemon half of
// kernel/DAEMON-LIFECYCLE.md §§1-3 that the CLI can observe.
//
// It exists because the CLI-side properties under test are about REAL
// PROCESSES: whether a detached child outlives its parent, whether two
// concurrent invocations end up with one socket owner, whether a losing child
// exits 3 and its CLI keeps polling. None of that can be faked with an
// injected `spawnProcess` seam. It is a stub only in that it serves a
// four-verb journal protocol instead of a journal.
//
// The one place it is NOT a faithful stub: §3 puts the singleton mutex in an
// `flock(2)` the kernel releases on any death, including SIGKILL. Node cannot
// call `flock`, so this uses `open(O_CREAT|O_EXCL)`, which is equally atomic
// across processes — exactly one caller wins a race — but is not released by
// the OS, so a dead holder is reclaimed by a pid check. That difference is
// invisible to the CLI, which only ever sees "the loser exited 3". The
// `flock` guarantee itself belongs to the kernel implementation and its
// `cargo test` cases (DAEMON-LIFECYCLE.md §6 tests 4 and 5).

import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import {
  appendFileSync,
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Must stay in lockstep with `packages/sdk/src/daemon-connection.ts::socketPathFor`
// and `kernel/relayflowd/src/socket_path.rs::derive_socket_path` (see #262). The
// CLI derives the same path from the same input; anti-hijack (DAEMON-LIFECYCLE
// §2 step 3) breaks the moment these diverge, so update all three together.
function deriveSocketPath(dataDir) {
  const absolute = resolve(dataDir);
  const hash = createHash('sha256').update(absolute).digest('hex').slice(0, 12);
  const runtime = (process.env.XDG_RUNTIME_DIR && process.env.XDG_RUNTIME_DIR.length > 0)
    ? process.env.XDG_RUNTIME_DIR
    : ((process.env.TMPDIR && process.env.TMPDIR.length > 0)
      ? process.env.TMPDIR
      : tmpdir());
  return join(runtime, `relayflowd-${hash}.sock`);
}

const EXIT_ALREADY_SERVING = 3;
const VERSION = '0.0.0-stub';

const argv = process.argv.slice(2);
if (!argv.includes('serve')) fail('stub relayflowd: expected a `serve` subcommand');
const dataDirIndex = argv.indexOf('--data-dir');
if (dataDirIndex === -1 || argv[dataDirIndex + 1] === undefined) {
  fail('stub relayflowd: expected --data-dir <dir>');
}
const dataDir = resolve(argv[dataDirIndex + 1]);
const socketPath = deriveSocketPath(dataDir);
const connectionPath = join(dataDir, 'connection.json');
const lockPath = join(dataDir, 'relayflowd.lock');

// Test knobs. Each one models a failure the CLI must classify, not a mode the
// real daemon has.
const protocol = Number(process.env['STUB_PROTOCOL'] ?? '0');
const startupExit = process.env['STUB_STARTUP_EXIT'];
const publishDelayMs = Number(process.env['STUB_PUBLISH_DELAY_MS'] ?? '0');
// Holds the lock but does not bind yet, so the CLI has to poll for readiness.
const listenDelayMs = Number(process.env['STUB_LISTEN_DELAY_MS'] ?? '0');
const writeConnectionFile = process.env['STUB_NO_CONNECTION_FILE'] !== '1';
// Append-only evidence for the live tests: one `start` line per process that
// was launched, one `serving` line per process that actually owns the socket,
// one `lost` line per process that exited 3. "Exactly one serving" is the
// property the concurrency case exists to check.
const tracePath = process.env['STUB_TRACE'];
function trace(line) {
  if (tracePath !== undefined) appendFileSync(tracePath, `${line}\n`);
}

if (startupExit !== undefined) {
  process.stderr.write('stub relayflowd: refusing to start (STUB_STARTUP_EXIT)\n');
  process.exit(Number(startupExit));
}

mkdirSync(dataDir, { recursive: true });
trace(`start ${process.pid}`);

// §3 step 3->4: acquire the singleton first. Everything destructive is
// sequenced after it, so a loser has unlinked nothing and bound nothing.
if (!acquireLock()) {
  process.stderr.write(`stub relayflowd: another relayflowd is already serving ${dataDir}\n`);
  trace(`lost ${process.pid}`);
  process.exit(EXIT_ALREADY_SERVING);
}

// §1 step 3: sweep a predecessor's leftovers, safe only under the lock.
rmSync(socketPath, { force: true });
rmSync(connectionPath, { force: true });

const server = createServer((socket) => {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      const request = JSON.parse(line);
      socket.write(`${JSON.stringify({ id: request.id, ok: true, result: reply(request) })}\n`);
    }
  });
  socket.on('error', () => {});
});

server.on('error', (error) => fail(`stub relayflowd: bind failed: ${error.message}`));
const bind = () => server.listen(socketPath, onListening);
if (listenDelayMs > 0) setTimeout(bind, listenDelayMs);
else bind();

function onListening() {
  trace(`serving ${process.pid}`);
  // §1: the connection file is written only after listen(2) has returned, so
  // a reader that sees the file can always connect. The delay knob widens
  // that window on purpose, to prove the CLI polls rather than assuming.
  const publish = () => {
    if (!writeConnectionFile) return;
    const temporary = `${connectionPath}.tmp.${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify({
      socket_path: socketPath,
      pid: process.pid,
      version: VERSION,
      protocol,
      started_at_ms: Date.now(),
    })}\n`, { mode: 0o600 });
    renameSync(temporary, connectionPath);
  };
  if (publishDelayMs > 0) setTimeout(publish, publishDelayMs);
  else publish();
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    rmSync(connectionPath, { force: true });
    rmSync(socketPath, { force: true });
    rmSync(lockPath, { force: true });
    process.exit(0);
  });
}

function reply(request) {
  switch (request.verb) {
    case 'hello':
      return { protocol, server: 'relayflowd-stub' };
    case 'run.start':
    case 'run.resume':
      return {
        run_id: 'STUBRUN00000000000000000A',
        status: 'completed',
        completion_reason: 'success',
        completed_steps: 1,
      };
    default:
      return {};
  }
}

/**
 * Write the pid into a private file first, then `link(2)` it into place.
 * `link` is atomic and fails EEXIST, so exactly one caller wins — and unlike
 * `open(O_CREAT|O_EXCL)` there is no window where the lock is visible but
 * still empty, which a rival would misread as a corpse and clear. A lock whose
 * recorded pid is gone IS a corpse (a hard kill) and is reclaimed once; the
 * kernel gets that for free from `flock`, which is why §3 chose it.
 */
function acquireLock() {
  const staging = `${lockPath}.tmp.${process.pid}`;
  const fd = openSync(staging, 'w', 0o600);
  writeSync(fd, String(process.pid));
  closeSync(fd);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        linkSync(staging, lockPath);
        return true;
      } catch (error) {
        if (error.code !== 'EEXIST' || attempt === 1) return false;
        const holder = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
        if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) return false;
        rmSync(lockPath, { force: true });
      }
    }
    return false;
  } finally {
    rmSync(staging, { force: true });
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
