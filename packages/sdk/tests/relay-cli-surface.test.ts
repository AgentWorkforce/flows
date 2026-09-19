import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSurfaceConforms,
  findSurfaceViolations,
  walkCommands,
  type RelayCliIo,
  type RelayCliSurface,
} from '@agent-relay/cli-surface';

import { createRelayCliSurface } from '../src/relay-cli.js';
import { CLI_VERBS, type CliCommandSpec, type CliOptionSpec, type CliVerbSpec } from '../src/cli-commands.js';
import { parseCliArgs, runCli, type ParsedArgs } from '../src/cli.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
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

const DIGEST = `hello@sha256:${'a'.repeat(64)}`;
const BUNDLE_DIR = `dist/flows/${DIGEST}`;
const RUN_ID = '01JABCDEFGHJKMNPQRSTVWXYZ0';

/**
 * One realistic invocation per declared command, and the `ParsedArgs` variant
 * it must produce.
 *
 * This is the only hand-written list in the drift check, and the test below
 * pins it to `CLI_VERBS` in both directions, so a verb added to the table
 * without a sample here fails rather than going silently unexercised.
 */
const INVOCATIONS: readonly { verb: string; argv: readonly string[]; variant: ParsedArgs['command'] }[] = [
  { verb: 'add', argv: ['add', 'my-helper'], variant: 'add' },
  { verb: 'answer', argv: ['answer', RUN_ID, 'human-1', 'yes'], variant: 'answer' },
  {
    verb: 'answer',
    argv: ['answer', '--json', '--no-spawn', '--data-dir', '.relayflowd',
      '--note', 'approved on the call', '--by', 'someone', RUN_ID, 'human-1', 'no'],
    variant: 'answer',
  },
  { verb: 'build', argv: ['build', 'flow.yaml'], variant: 'build' },
  { verb: 'build', argv: ['build', '--out', 'dist', '--json', 'flow.yaml'], variant: 'build' },
  // `--verify` is a flag like any other: both orders help implies must parse.
  { verb: 'build', argv: ['build', '--verify', '--json', BUNDLE_DIR], variant: 'build' },
  { verb: 'build', argv: ['build', BUNDLE_DIR, '--verify'], variant: 'build' },
  { verb: 'check', argv: ['check', 'flow.yaml'], variant: 'check' },
  { verb: 'check', argv: ['check', '--watch', '--json', 'flow.yaml'], variant: 'check' },
  // Both `deploy` forms: the positional decides which variant the verb produces.
  { verb: 'deploy', argv: ['deploy', DIGEST, '--to', 'file:///tmp/bucket'], variant: 'deploy' },
  { verb: 'deploy', argv: ['deploy', DIGEST, '--to', 'file:///tmp/bucket', '--json'], variant: 'deploy' },
  {
    verb: 'deploy',
    argv: ['deploy', 'review.flow.ts', '--repo', 'owner/name', '--on', 'github', '--approver', 'someone'],
    variant: 'cloud-deploy',
  },
  {
    verb: 'deploy',
    argv: ['deploy', 'review.flow.ts', '--repo', 'owner/name', '--on', 'github:label=review',
      '--approver', 'someone', '--name', 'review-listener', '--agents', 'claude,codex', '--draft',
      '--no-connect', '--json'],
    variant: 'cloud-deploy',
  },
  { verb: 'deployments', argv: ['deployments', '--json'], variant: 'deployments' },
  { verb: 'hn-monitor', argv: ['hn-monitor', 'start', 'spec.json'], variant: 'hn-monitor' },
  {
    verb: 'hn-monitor',
    argv: ['hn-monitor', 'start', '--data-dir', '.relayflowd', '--poll-interval-ms', '1000', 'spec.json'],
    variant: 'hn-monitor',
  },
  { verb: 'observer', argv: ['observer'], variant: 'observer' },
  { verb: 'observer', argv: ['observer', '--data-dir', '.relayflowd'], variant: 'observer' },
  { verb: 'replay', argv: ['replay', RUN_ID], variant: 'replay' },
  {
    verb: 'replay',
    argv: ['replay', '--json', '--data-dir', '.relayflowd', '--at', 'step-1',
      '--allow-human-influenced', RUN_ID],
    variant: 'replay',
  },
  { verb: 'resume', argv: ['resume', RUN_ID], variant: 'resume' },
  {
    verb: 'resume',
    argv: ['resume', '--json', '--data-dir', '.relayflowd', '--local-agent', '--no-spawn',
      '--no-observer-link', '--allow-human-influenced', RUN_ID],
    variant: 'resume',
  },
  { verb: 'run', argv: ['run', 'flow.yaml'], variant: 'run' },
  {
    verb: 'run',
    argv: ['run', '--json', '--data-dir', '.relayflowd', '--local-agent', '--no-spawn',
      '--no-observer-link', '--allow-human-influenced', '--input', '{"a":1}', 'review.flow.ts'],
    variant: 'run',
  },
  // `--input` is the authored body's argument and `--reuse-from` memoizes a
  // declarative run, so they belong to different sources rather than one argv.
  { verb: 'run', argv: ['run', '--reuse-from', RUN_ID, 'flow.yaml'], variant: 'run' },
  { verb: 'run', argv: ['run', '--bucket', 'file:///tmp/bucket', DIGEST], variant: 'run' },
  // `--cloud` is the second variant of the same verb.
  { verb: 'run', argv: ['run', '--cloud', '--wait', 'flow.yaml'], variant: 'cloud-run' },
  { verb: 'run', argv: ['run', '--cloud', '--sync-code', '--no-connect', 'review.flow.ts'], variant: 'cloud-run' },
  // With neither --cron nor --every the flow's own `schedule.*` handler supplies
  // the cron, so the bare form has to parse.
  { verb: 'schedule', argv: ['schedule', 'review.flow.ts'], variant: 'schedule' },
  { verb: 'schedule', argv: ['schedule', '--cron', '0 9 * * *', 'flow.yaml'], variant: 'schedule' },
  {
    verb: 'schedule',
    // `--input` is the authored body's argument, so it travels with a .flow.ts.
    argv: ['schedule', '--every', '15m', '--tz', 'America/New_York', '--name', 'nightly-review',
      '--input', '{"a":1}', '--no-connect', '--json', 'review.flow.ts'],
    variant: 'schedule',
  },
  { verb: 'schedules', argv: ['schedules'], variant: 'schedules' },
  { verb: 'schedules', argv: ['schedules', '--json'], variant: 'schedules' },
  {
    verb: 'serve-webhook',
    argv: ['serve-webhook', '--data-dir', '/tmp/inbox', '--port', '8080', '--allow', 'review,triage'],
    variant: 'serve-webhook',
  },
  // `--data-dir` carries a default in the tree, so the receiver has to start without it.
  { verb: 'serve-webhook', argv: ['serve-webhook', '--port', '8080'], variant: 'serve-webhook' },
  // The run id is optional: inside a step the environment supplies it.
  { verb: 'status', argv: ['status'], variant: 'status' },
  { verb: 'status', argv: ['status', '--json', '--data-dir', '.relayflowd', '--tail', '5', RUN_ID], variant: 'status' },
  { verb: 'sync', argv: ['sync', RUN_ID], variant: 'sync' },
  { verb: 'sync', argv: ['sync', '--dry-run', '--json', '--dir', '.', RUN_ID], variant: 'sync' },
  {
    verb: 'tick',
    argv: ['tick', 'start', '--schedule-id', 'nightly', '--interval-ms', '60000', 'spec.json'],
    variant: 'tick',
  },
  {
    verb: 'tick',
    argv: ['tick', 'start', '--data-dir', '.relayflowd', '--schedule-id', 'nightly',
      '--interval-ms', '60000', '--epoch-ms', '0', '--max-catch-up', '3',
      '--poll-interval-ms', '1000', 'spec.json'],
    variant: 'tick',
  },
  { verb: 'undeploy', argv: ['undeploy', 'dep_123'], variant: 'undeploy' },
  { verb: 'undeploy', argv: ['undeploy', '--json', 'dep_123'], variant: 'undeploy' },
  { verb: 'unschedule', argv: ['unschedule', 'sched_123'], variant: 'unschedule' },
  { verb: 'unschedule', argv: ['unschedule', '--json', 'sched_123'], variant: 'unschedule' },
];

/** Every command in the declared tree, with the argv tokens that reach it. */
function declaredCommands(): { command: CliCommandSpec; path: readonly string[] }[] {
  return (CLI_VERBS as readonly CliVerbSpec[]).flatMap((verb) => [
    { command: verb as CliCommandSpec, path: [verb.name] },
    ...(verb.subcommands ?? []).map((sub) => ({ command: sub, path: [verb.name, sub.name] })),
  ]);
}

/** `'--out <dir>'` -> `'--out'`: the token a user actually types. */
function flagToken(option: CliOptionSpec): string {
  return option.flags.split(' ')[0]!;
}

function reaches(argv: readonly string[], path: readonly string[]): boolean {
  return path.every((token, index) => argv[index] === token);
}

/**
 * Where the positionals are in an invocation of `command`, reading the declared
 * options to know which tokens are flag values rather than arguments.
 */
function positionalIndices(command: CliCommandSpec, argv: readonly string[], start: number): number[] {
  const takesValue = new Set(
    (command.options ?? []).filter((option) => option.flags.includes('<')).map(flagToken),
  );
  const indices: number[] = [];
  for (let index = start; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith('-')) indices.push(index);
    else if (takesValue.has(token)) index += 1;
  }
  return indices;
}

describe('relay-cli surface: contract conformance', () => {
  it('satisfies the structural contract from @agent-relay/cli-surface', () => {
    // Typed assignment, not a cast: this is where the locally-declared surface
    // shape in src/relay-cli.ts is proven to BE a RelayCliSurface. If the two
    // drift, this file stops compiling under `npm run typecheck:tests`.
    const surface: RelayCliSurface = createRelayCliSurface();

    expect(findSurfaceViolations(surface)).toEqual([]);
    expect(() => assertSurfaceConforms(surface)).not.toThrow();
  });

  it('identifies itself as relayflows on contract v1 with this package version', async () => {
    const surface = createRelayCliSurface();
    const manifest: { version: string } = JSON.parse(
      await import('node:fs/promises').then((fs) =>
        fs.readFile(new URL('../package.json', import.meta.url), 'utf8')),
    );

    expect(surface.id).toBe('relayflows');
    expect(surface.contract).toBe(1);
    // Read from the manifest, so a release bump cannot leave a stale literal.
    expect(surface.version).toBe(manifest.version);
    expect(surface.version).not.toBe('0.0.0');
  });

  it('declares no routing internals to the host', () => {
    // `variants` is how the table ties itself to ParsedArgs; it is not part of
    // the contract and must not leak into the mounted tree.
    for (const { command } of walkCommands(createRelayCliSurface().commands)) {
      expect(command).not.toHaveProperty('variants');
    }
  });
});

describe('relay-cli surface: drift between `commands` and `run`', () => {
  const surface = createRelayCliSurface();
  const declaredTopLevel = surface.commands.map((command) => command.name);

  it('declares exactly the verbs the parser dispatches', () => {
    // Both sides read CLI_VERBS, so this pins the projection rather than a
    // second list: `commands` must lose nothing on its way to the host.
    expect(declaredTopLevel).toEqual(CLI_VERBS.map((verb) => verb.name));
  });

  it('exercises every declared command, and only declared commands', () => {
    // Closes the loop on INVOCATIONS: a verb added to CLI_VERBS with no sample
    // below fails here instead of quietly skipping the routing assertion.
    expect(new Set(INVOCATIONS.map((invocation) => invocation.verb)))
      .toEqual(new Set(declaredTopLevel));
  });

  it.each(INVOCATIONS)('routes `flows $verb` to the $variant variant', ({ verb, argv, variant }) => {
    const parsed = parseCliArgs(argv);

    expect(parsed, `\`${argv.join(' ')}\` did not parse`).toBeDefined();
    expect(parsed!.command).toBe(variant);

    // And the variant it produced must be one the table says this verb yields.
    const declared = CLI_VERBS.find((entry) => entry.name === verb);
    expect(declared, `${verb} is declared`).toBeDefined();
    expect(declared!.variants as readonly string[]).toContain(parsed!.command);
  });

  it('reaches every ParsedArgs variant from a declared command', () => {
    // The other direction of the drift check. The compile-time assertion in
    // cli-commands.ts proves every variant is *claimed* by a verb; this proves
    // each claim is actually reachable through the parser.
    const claimed = new Set(CLI_VERBS.flatMap((verb) => verb.variants as readonly string[]));
    const reached = new Set(INVOCATIONS.map((invocation) => invocation.variant));

    expect(reached).toEqual(claimed);
  });

  it('declares no flag the parser refuses everywhere', () => {
    // The other half of command drift: a verb can be declared correctly and
    // still advertise a switch nothing accepts. Every declared boolean option
    // has to be accepted by at least one of that verb's sample invocations --
    // "at least one", because some flags are only valid in combination
    // (`run --wait` needs `--cloud`, `deploy --draft` only the hosted form).
    // Value-taking options are left out: their placeholder is not an argv token.
    const declaredFlags = (CLI_VERBS as readonly CliVerbSpec[]).flatMap((verb) => [
      ...(verb.options ?? []).map((option) => option.flags),
      ...(verb.subcommands ?? []).flatMap((sub) => (sub.options ?? []).map((option) => option.flags)),
    ].filter((flags) => !flags.includes('<')).map((flags) => ({ verb: verb.name, flags })));

    // A real table always has some; an empty list would make this test vacuous.
    expect(declaredFlags.length).toBeGreaterThan(0);

    for (const { verb, flags } of declaredFlags) {
      const samples = INVOCATIONS.filter((invocation) => invocation.verb === verb);
      expect(samples.length, `${verb} has a sample invocation`).toBeGreaterThan(0);

      const accepted = samples.some(({ argv }) => {
        // A sample that already carries the flag has answered the question;
        // adding it a second time is a duplicate, which every verb refuses.
        if (argv.includes(flags)) return parseCliArgs(argv) !== undefined;
        // Otherwise: after the verb, and after its subcommand token where there is one.
        const at = (CLI_VERBS as readonly CliVerbSpec[])
          .find((entry) => entry.name === verb)!.subcommands?.length ? 2 : 1;
        return parseCliArgs([...argv.slice(0, at), flags, ...argv.slice(at)]) !== undefined;
      });

      expect(accepted, `\`flows ${verb} ${flags}\` is accepted by the parser`).toBe(true);
    }
  });

  it('carries every declared flag on an invocation that parses', () => {
    // The stronger half of the same guard. Inserting a flag into one sample
    // only proves it is tolerated in that position; this proves every declared
    // option -- value-taking ones included, which the insertion check has to
    // skip -- is carried by a real invocation of its own command, and the
    // routing test above proves each of those invocations parses.
    //
    // This is what `build --json`, `build <dir> --verify` and `deploy --json`
    // failed: help listed them, no invocation could carry them.
    const uncarried: string[] = [];

    for (const { command, path } of declaredCommands()) {
      for (const option of command.options ?? []) {
        const flag = flagToken(option);
        const carried = INVOCATIONS.some(
          ({ argv }) => reaches(argv, path) && argv.includes(flag) && parseCliArgs(argv) !== undefined,
        );
        if (!carried) uncarried.push(`flows ${path.join(' ')} ${flag}`);
      }
    }

    expect(uncarried).toEqual([]);
  });

  it('lets every option that declares a default be omitted', () => {
    // A `defaultValue` in the tree is help telling the reader the flag is
    // optional. `serve-webhook` advertised `--data-dir` with `.relayflowd` and
    // then exited 2 without it; a default the parser does not honour is the
    // same drift as a flag it refuses.
    const undefaulted: string[] = [];

    for (const { command, path } of declaredCommands()) {
      for (const option of command.options ?? []) {
        if (option.defaultValue === undefined) continue;
        const flag = flagToken(option);
        const omitted = INVOCATIONS.some(
          ({ argv }) => reaches(argv, path) && !argv.includes(flag) && parseCliArgs(argv) !== undefined,
        );
        if (!omitted) undefaulted.push(`flows ${path.join(' ')} without ${flag}`);
      }
    }

    expect(undefaulted).toEqual([]);
  });

  it('parses exactly the positional arity each command declares', () => {
    // The third way help can lie: the right flags on the wrong number of
    // arguments. Every sample must carry exactly the declared positionals, and
    // a positional declared `required: true` must actually be required.
    for (const { command, path } of declaredCommands()) {
      // A verb that routes on a subcommand declares no positionals of its own;
      // its arguments belong to the subcommand entry, checked on its own turn.
      if (command.subcommands?.length) continue;

      const required = (command.args ?? []).filter((arg) => arg.required).length;
      const declared = (command.args ?? []).length;
      const variadic = (command.args ?? []).some((arg) => arg.variadic);
      const samples = INVOCATIONS.filter(({ argv }) => reaches(argv, path));

      expect(samples.length, `flows ${path.join(' ')} has a sample invocation`).toBeGreaterThan(0);

      const arities = new Set<number>();
      for (const { argv } of samples) {
        const positionals = positionalIndices(command, argv, path.length);
        const rendered = `flows ${argv.join(' ')}`;
        if (variadic) expect(positionals.length, rendered).toBeGreaterThanOrEqual(required);
        else if (declared === required) expect(positionals.length, rendered).toBe(required);
        else {
          // An optional positional (`status [<run-id>]`): within the declared
          // range, and the samples must exercise both ends of it, so an
          // optional that the parser actually requires — or a required one
          // it merely documents — is caught either way.
          expect(positionals.length, rendered).toBeGreaterThanOrEqual(required);
          expect(positionals.length, rendered).toBeLessThanOrEqual(declared);
        }
        arities.add(positionals.length);
      }
      if (!variadic && declared !== required) {
        expect(arities, `flows ${path.join(' ')} samples both ${required} and ${declared} positionals`).toEqual(new Set([required, declared]));
      }

      if (required === 0) continue;

      // And dropping the last declared positional is refused, so `required`
      // means required rather than "documented".
      const { argv } = samples[0]!;
      const last = positionalIndices(command, argv, path.length).at(-1)!;
      const short = [...argv.slice(0, last), ...argv.slice(last + 1)];

      expect(parseCliArgs(short), `\`flows ${short.join(' ')}\` is refused`).toBeUndefined();
    }
  });

  it('refuses a flag it does not declare', () => {
    // And the converse, spot-checked where the table is most likely to go
    // stale: an undeclared switch is a parse failure, not a silent no-op.
    const declared = new Set(
      (CLI_VERBS.find((verb) => verb.name === 'sync')!.options ?? []).map((option) => option.flags),
    );

    expect(declared).toEqual(new Set(['--json', '--dry-run', '--dir <path>']));
    expect(parseCliArgs(['sync', '--dry', RUN_ID])).toBeUndefined();
    expect(parseCliArgs(['sync', '--exclude', '.trajectories/**', RUN_ID])).toBeUndefined();
  });

  it('declares each subcommand under the name the parser actually requires', () => {
    // `hn-monitor` and `tick` route on a second token. The tree must name that
    // token exactly, or the host's help sends users to an invocation that
    // refuses. (Probing the no-subcommand verbs the same way would prove
    // nothing: `flows add start` legitimately parses, with `start` as the
    // helper name.)
    for (const verb of CLI_VERBS as readonly CliVerbSpec[]) {
      if (!verb.subcommands?.length) continue;

      // Every declared subcommand is the leading token of a routable invocation.
      for (const sub of verb.subcommands) {
        const sample = INVOCATIONS.find(
          (invocation) => invocation.verb === verb.name && invocation.argv[1] === sub.name,
        );
        expect(sample, `${verb.name} ${sub.name} has a routable invocation`).toBeDefined();
      }

      // And the token is required: the same argv without it is refused.
      const routable = INVOCATIONS.find((invocation) => invocation.verb === verb.name)!;
      const withoutSubcommand = [routable.argv[0]!, ...routable.argv.slice(2)];
      expect(
        parseCliArgs(withoutSubcommand),
        `${verb.name} without its subcommand is refused`,
      ).toBeUndefined();
    }
  });
});

describe('relay-cli surface: run() behaviour', () => {
  it('refuses an unknown command with exit 2 and names it on stderr', async () => {
    const io = capture();

    await expect(createRelayCliSurface().run(['bogus'], io)).resolves.toBe(2);

    expect(io.err).toContain("'bogus' is not a command of relayflows");
    expect(io.out).toBe('');
  });

  it('writes only through the supplied io', async () => {
    const io = capture();

    await expect(createRelayCliSurface().run(['--help'], io)).resolves.toBe(0);

    expect(io.out).toContain('flows run');
    // Line-oriented CliIo, chunk-oriented RelayCliIo: the adapter must add the
    // terminator, or the host renders every command on one line.
    expect(io.out.endsWith('\n')).toBe(true);
  });

  it('installs no process signal handlers, unlike the standalone binary', async () => {
    const before = {
      int: process.listenerCount('SIGINT'),
      term: process.listenerCount('SIGTERM'),
    };
    const io = capture();
    const aborted = AbortSignal.abort();

    // serve-webhook is one of the five verbs that used to install handlers. It
    // really starts the receiver, then stops on the signal rather than a SIGINT.
    const code = await createRelayCliSurface({ signal: aborted })
      .run(['serve-webhook', '--data-dir', temporaryDirectory('flows-surface-'), '--port', '0'], io);

    expect(code).toBe(0);
    expect(io.out).toContain('WEBHOOK http://127.0.0.1:');
    expect(process.listenerCount('SIGINT')).toBe(before.int);
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
  });

  it('leaves the standalone runCli path handling SIGINT as it always did', async () => {
    // The other half of the same change: `bin/flows.js` passes no signal, so
    // runCli must still own SIGINT. Proven by the real mechanism -- emitting
    // the signal is what stops the receiver.
    const io = { stdout: () => {}, stderr: () => {} };
    const started = runCli(
      ['serve-webhook', '--data-dir', temporaryDirectory('flows-standalone-'), '--port', '0'],
      io,
    );

    // Yield until the handler is installed, then interrupt as a user would.
    while (process.listenerCount('SIGINT') === 0) await new Promise((r) => setImmediate(r));
    process.emit('SIGINT');

    await expect(started).resolves.toBe(0);
  });
});
