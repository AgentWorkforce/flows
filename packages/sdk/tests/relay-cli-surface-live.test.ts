import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import type { RelayCliIo } from '@agent-relay/cli-surface';

import { createRelayCliSurface } from '../src/relay-cli.js';

/**
 * The end-to-end bar for the mounted surface: real flows, executed by the real
 * relayflowd kernel, reached only through `surface.run(...)`.
 *
 * Nothing is stubbed and nothing is mocked. The surface spawns the daemon, the
 * kernel journals the run, and the assertions are on what the host would
 * actually see -- the exit code, the output the surface wrote to its injected
 * io, and (for the authored flow) the side effect the run left on disk.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const YAML_FLOW = join(ROOT, 'testdata', 'hello-deterministic.flow.yaml');
const AUTHORED_FLOW = join(HERE, 'fixtures', 'direct-input.flow.ts');

const KERNEL = process.env['RELAYFLOWD_BIN'];
/** Opt in with the same real-kernel override the other SDK live tests use. */
const noKernel = !KERNEL || !existsSync(KERNEL);

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    // Stop the daemon this run spawned before removing its data directory.
    try {
      const connection: { pid?: number } = JSON.parse(
        readFileSync(join(directory, 'connection.json'), 'utf8'),
      );
      if (typeof connection.pid === 'number') process.kill(connection.pid, 'SIGTERM');
    } catch {
      // No daemon to stop when preflight refused before spawning one.
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

function dataDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function capture(): RelayCliIo & { out: string; err: string } {
  const sink = {
    out: '',
    err: '',
    stdout(chunk: string) { sink.out += chunk; },
    stderr(chunk: string) { sink.err += chunk; },
  };
  return sink;
}

it.skipIf(noKernel)(
  'runs a declarative flow end to end on the real kernel through surface.run',
  async () => {
    const dataDir = dataDirectory('flows-surface-e2e-');
    const io = capture();

    const code = await createRelayCliSurface().run(
      ['run', '--data-dir', dataDir, '--no-observer-link', YAML_FLOW],
      io,
    );

    expect(code, io.err || io.out).toBe(0);
    // The run summary the host would show the user, on the injected stdout.
    expect(io.out).toMatch(/^RUN \S+ completed \(2 steps\) completionReason: success$/m);
    // Preflight diagnostics go to the injected stderr, not the process's own.
    expect(io.err).toContain('WARNING [unprovable_effects]');
  },
  60_000,
);

it.skipIf(noKernel)(
  'reports the same declarative run as one JSON object under --json',
  async () => {
    const dataDir = dataDirectory('flows-surface-e2e-json-');
    const io = capture();

    const code = await createRelayCliSurface().run(
      ['run', '--json', '--data-dir', dataDir, '--no-observer-link', YAML_FLOW],
      io,
    );

    expect(code, io.err || io.out).toBe(0);
    const report: unknown = JSON.parse(io.out);
    expect(report).toMatchObject({ completionReason: 'success', completedSteps: 2 });
  },
  60_000,
);

it.skipIf(noKernel)(
  'streams authored step progress through the injected io, and leaves the run’s side effect on disk',
  async () => {
    // An authored .flow.ts, because per-step progress is emitted by the
    // authored executor (`observeStep`); a declarative YAML flow is stepped by
    // the kernel and reports only its summary. Asserting progress on the YAML
    // run would be asserting something the runtime never emits.
    const dataDir = dataDirectory('flows-surface-e2e-authored-');
    const written = join(dataDir, 'written.txt');
    const io = capture();

    const code = await createRelayCliSurface().run(
      [
        'run', '--data-dir', dataDir, '--no-observer-link', AUTHORED_FLOW,
        '--input', JSON.stringify({ output: written, value: 'hello-from-surface' }),
      ],
      io,
    );

    expect(code, io.err || io.out).toBe(0);
    // Progress, rendered by `renderProgress` and routed to the host's stderr.
    expect(io.err).toMatch(/○ run-1 \(deterministic\)/);
    expect(io.err).toMatch(/✓ run-1 \(deterministic\).*completionReason: success/);
    expect(io.out).toMatch(/^RUN \S+ completed \(2 steps\) completionReason: success$/m);
    // The step really executed: its shell command wrote this file.
    expect(readFileSync(written, 'utf8')).toBe('hello-from-surface');
  },
  60_000,
);
