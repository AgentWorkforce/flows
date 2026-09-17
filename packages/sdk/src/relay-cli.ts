import { readFileSync } from 'node:fs';

import { runCli } from './cli.js';
import { CLI_VERBS, CLI_VERB_NAMES, type CliCommandSpec } from './cli-commands.js';

/**
 * The `@relayflows/sdk/relay-cli` entrypoint: a mountable CLI surface.
 *
 * `agent-relay` mounts this as `agent-relay flows`. The surface is a thin
 * projection over the CLI this package already ships -- `commands` comes from
 * the same `CLI_VERBS` table `parseArgs` dispatches on, and `run` delegates
 * straight to `runCli`. No command is reimplemented here, and
 * `packages/relayflows/bin/flows.js` keeps calling `runCli` on the same path.
 *
 * Structurally typed against `@agent-relay/cli-surface` without importing it,
 * so `dist/relay-cli.d.ts` has no dependency on the contract package and this
 * package gains no runtime dependency on relay. `tests/relay-cli-surface.test.ts`
 * asserts the assignability and runs the contract's own conformance checks.
 */

/** Host-supplied output sink. Mirrors `RelayCliIo`. */
export interface RelayCliIo {
  stdout(chunk: string): void;
  stderr(chunk: string): void;
}

/** A mountable product CLI. Mirrors `RelayCliSurface`. */
export interface RelayCliSurface {
  id: string;
  version: string;
  contract: 1;
  commands: readonly CliCommandSpec[];
  run(argv: readonly string[], io: RelayCliIo): Promise<number>;
}

/** Options for {@link createRelayCliSurface}. */
export interface CreateRelayCliSurfaceOptions {
  /**
   * Cancellation for the long-running verbs, owned by the host.
   *
   * A surface must install no global signal handlers, so one is always passed
   * to `runCli` -- a never-aborting signal when the host supplies none. Pass a
   * real one to get graceful cancellation (for example, the
   * "Stopped observing; the hosted run has not been cancelled" path on
   * `run --cloud --wait`) instead of the host's SIGINT killing the process.
   */
  signal?: AbortSignal;
}

/** Exit code for an argv the surface cannot route, per the contract. */
const EXIT_UNKNOWN_COMMAND = 2;

/** Drop `variants` -- the routing detail the host has no use for. */
function toCommandSpec(verb: CliCommandSpec & { variants?: unknown }): CliCommandSpec {
  const { variants: _variants, ...spec } = verb;
  return spec;
}

/**
 * Read this package's version from its own manifest.
 *
 * Resolved from `import.meta.url` rather than imported, because `package.json`
 * sits outside `rootDir` and a hardcoded literal would silently go stale at the
 * next release. `src/` and `dist/` are both one level below the manifest, so
 * the same relative path is correct before and after a build.
 */
function packageVersion(): string {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    const version = (manifest as { version?: unknown }).version;
    return typeof version === 'string' && version.length > 0 ? version : '0.0.0';
  } catch {
    // A surface that cannot read its own manifest is still perfectly runnable;
    // refusing to mount over a cosmetic field would be the worse failure.
    return '0.0.0';
  }
}

/**
 * Build the relayflows CLI surface.
 *
 * @param options - Host-supplied cancellation.
 * @returns A surface whose `run` resolves to an exit code, writes only through
 *   the supplied io, and installs no process signal handlers.
 */
export function createRelayCliSurface(
  options: CreateRelayCliSurfaceOptions = {},
): RelayCliSurface {
  return {
    id: 'relayflows',
    version: packageVersion(),
    contract: 1,
    commands: CLI_VERBS.map(toCommandSpec),
    async run(argv: readonly string[], io: RelayCliIo): Promise<number> {
      const verb = argv[0];
      // `runCli` would refuse this too, but with the full usage block. Naming
      // the offending token is the more useful answer when the host has just
      // routed `agent-relay flows <typo>` here.
      if (verb !== undefined && !verb.startsWith('-') && !CLI_VERB_NAMES.has(verb)) {
        io.stderr(`error: '${verb}' is not a command of relayflows\n`);
        io.stderr("Run 'agent-relay flows --help' for the available commands.\n");
        return EXIT_UNKNOWN_COMMAND;
      }
      return runCli(
        argv,
        // `CliIo` is line-oriented and the contract's io is chunk-oriented, so
        // the terminator is added here rather than by every call site.
        { stdout: (line) => io.stdout(`${line}\n`), stderr: (line) => io.stderr(`${line}\n`) },
        // Always pass a signal: that is what keeps `runCli` from installing the
        // SIGINT/SIGTERM handlers the standalone binary still relies on.
        { signal: options.signal ?? new AbortController().signal },
      );
    },
  };
}
