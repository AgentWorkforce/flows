import { DEFAULT_DATA_DIR } from './daemon-connection.js';
import type { ParsedArgs } from './cli.js';

/**
 * The one declaration of the `flows` command surface.
 *
 * Two consumers read this table and nothing else:
 *
 * 1. `parseArgs` in `cli.ts` gates its verb dispatch on {@link CLI_VERB_NAMES},
 *    so a token that is not in this table can never reach a parser.
 * 2. `createRelayCliSurface` in `relay-cli.ts` projects it into the
 *    `RelayCliSurface.commands` tree the `agent-relay` host mounts.
 *
 * Because both sides derive from one array, `commands` and `run` cannot
 * describe different trees. The drift test proves the remaining direction --
 * that each declared command actually parses -- and {@link CLI_VERBS} carries a
 * compile-time assertion that every `ParsedArgs` variant is claimed by some
 * verb, so extending the union without extending this table fails `tsc`.
 *
 * The types here are deliberately local rather than imported from
 * `@agent-relay/cli-surface`: they are structurally identical, and keeping the
 * import out means `dist/relay-cli.d.ts` stands alone, so a consumer of
 * `@relayflows/sdk` never needs the contract package resolvable. Assignability
 * to the real contract is asserted in `tests/relay-cli-surface.test.ts`.
 */

/** A positional argument. Mirrors `RelayCliArgSpec`. */
export interface CliArgSpec {
  name: string;
  description: string;
  required: boolean;
  variadic?: boolean;
}

/** A flag, in commander's flag-string form. Mirrors `RelayCliOptionSpec`. */
export interface CliOptionSpec {
  flags: string;
  description: string;
  defaultValue?: string | boolean | number;
}

/** One node of the command tree. Mirrors `RelayCliCommandSpec`. */
export interface CliCommandSpec {
  name: string;
  description: string;
  aliases?: readonly string[];
  args?: readonly CliArgSpec[];
  options?: readonly CliOptionSpec[];
  subcommands?: readonly CliCommandSpec[];
}

/** A top-level verb, plus the `ParsedArgs` variants it can produce. */
export interface CliVerbSpec extends CliCommandSpec {
  /**
   * Every `ParsedArgs.command` this verb can parse to.
   *
   * Usually one, but the verb set and the variant set are not one-to-one:
   * `deploy` produces `deploy` for a digest reference and `cloud-deploy` for
   * authored source, and `run` produces `cloud-run` under `--cloud`.
   */
  variants: readonly ParsedArgs['command'][];
}

const DATA_DIR_OPTION: CliOptionSpec = {
  flags: '--data-dir <dir>',
  description: 'Daemon data directory',
  defaultValue: DEFAULT_DATA_DIR,
};

const JSON_OPTION: CliOptionSpec = {
  flags: '--json',
  description: 'Emit one machine-readable JSON object instead of text',
};

/**
 * Shared by the verbs that hand a flow to Cloud. Each of them preflights what
 * the source needs connected and offers to connect it; this refuses instead,
 * which is what a non-interactive caller wants.
 */
const NO_CONNECT_OPTION: CliOptionSpec = {
  flags: '--no-connect',
  description: 'Refuse a missing integration instead of offering to connect it',
};

/** Flags shared by the two verbs that execute a flow locally. */
const LOCAL_EXECUTION_OPTIONS = [
  JSON_OPTION,
  DATA_DIR_OPTION,
  { flags: '--local-agent', description: 'Run agent steps in this process instead of a worker' },
  { flags: '--no-spawn', description: 'Require a running relayflowd rather than starting one' },
  { flags: '--no-observer-link', description: 'Do not mint an observer link for this run' },
  {
    flags: '--allow-human-influenced',
    description: 'Proceed even though the run carries human-influenced state',
  },
] as const satisfies readonly CliOptionSpec[];

/**
 * `as const satisfies` rather than a type annotation on purpose: an annotation
 * would widen every `variants` entry to `ParsedArgs['command']` and the
 * compile-time exhaustiveness assertion below would pass vacuously.
 */
export const CLI_VERBS = [
  {
    name: 'add',
    description: 'Install a helper plugin into this project',
    args: [{ name: 'helper', description: 'Helper name or @flows/<helper-name>', required: true }],
    variants: ['add'],
  },
  {
    name: 'answer',
    description: 'Answer a run’s parked f.human question; `flows resume` then continues the body',
    args: [
      { name: 'run-id', description: 'Run parked on the question', required: true },
      { name: 'wait-id', description: 'Which question to answer, named human-<n> in the order the body asked', required: true },
      { name: 'answer', description: 'The decision, as yes or no (also true or false)', required: true },
    ],
    options: [
      JSON_OPTION,
      DATA_DIR_OPTION,
      { flags: '--no-spawn', description: 'Require a running relayflowd rather than starting one' },
      { flags: '--note <text>', description: 'Reason recorded on the journal alongside the answer' },
      { flags: '--by <identity>', description: 'Who answered, when relaying a person’s decision; defaults to the OS user' },
    ],
    variants: ['answer'],
  },
  {
    name: 'build',
    description: 'Compile a flow into a sealed, content-addressed bundle',
    args: [{ name: 'source', description: 'flow.yaml, flow.ts, or a bundle directory with --verify', required: true }],
    options: [
      { flags: '--out <dir>', description: 'Directory to write the bundle into; not valid with --verify' },
      { flags: '--verify', description: 'Verify an existing bundle directory instead of building' },
      JSON_OPTION,
    ],
    variants: ['build'],
  },
  {
    name: 'check',
    description: 'Compile and preflight a flow without running it, or opening a daemon socket',
    args: [{ name: 'source', description: 'flow.ts, flow.yaml, or spec.json', required: true }],
    options: [JSON_OPTION, { flags: '--watch', description: 'Re-check on every change to the flow and its imports' }],
    variants: ['check'],
  },
  {
    name: 'deploy',
    description: 'Copy a sealed bundle into a file bucket, or deploy a hosted trigger listener',
    args: [{ name: 'flow', description: 'flow.ts for a hosted listener, or <flow>@sha256:<digest> for a bundle', required: true }],
    options: [
      { flags: '--to <file-bucket-uri>', description: 'Destination file bucket for a sealed bundle' },
      { flags: '--repo <owner/name>', description: 'Repository the hosted listener watches' },
      { flags: '--on <provider>', description: 'Trigger source, as <provider>[:key=value,...]; repeatable' },
      { flags: '--approver <handle>', description: 'Handle delivered to every launched run as input.approver' },
      { flags: '--agents <list>', description: 'Agent harnesses to allow, as claude[,codex]' },
      { flags: '--name <name>', description: 'Name for the hosted listener' },
      { flags: '--draft', description: 'Create the listener without activating it' },
      NO_CONNECT_OPTION,
      JSON_OPTION,
    ],
    variants: ['deploy', 'cloud-deploy'],
  },
  {
    name: 'deployments',
    description: 'List this workspace’s hosted trigger listeners',
    options: [JSON_OPTION],
    variants: ['deployments'],
  },
  {
    name: 'hn-monitor',
    description: 'Hacker News monitor: poll for matching stories and launch a flow per hit',
    subcommands: [
      {
        name: 'start',
        description: 'Start polling in the foreground',
        args: [{ name: 'spec', description: 'Monitor spec.json', required: true }],
        options: [
          DATA_DIR_OPTION,
          { flags: '--poll-interval-ms <ms>', description: 'Milliseconds between polls' },
        ],
      },
    ],
    variants: ['hn-monitor'],
  },
  {
    name: 'observer',
    description: 'Mint a read-only observer link without running a flow',
    options: [DATA_DIR_OPTION],
    variants: ['observer'],
  },
  {
    name: 'replay',
    description: 'Replay a finished run from its local journal',
    args: [{ name: 'run-id', description: 'Run id to replay', required: true }],
    options: [
      JSON_OPTION,
      DATA_DIR_OPTION,
      { flags: '--at <step-id>', description: 'Replay up to this step' },
      {
        flags: '--allow-human-influenced',
        description: 'Proceed even though the run carries human-influenced state',
      },
    ],
    variants: ['replay'],
  },
  {
    name: 'resume',
    description: 'Resume an interrupted local run from where its journal left off',
    args: [{ name: 'run-id', description: 'Run id to resume', required: true }],
    options: LOCAL_EXECUTION_OPTIONS,
    variants: ['resume'],
  },
  {
    name: 'run',
    description: 'Run a flow locally, or submit it to Cloud with --cloud',
    args: [{ name: 'flow', description: 'flow.yaml, flow.ts, spec.json, or <flow>@sha256:<digest>', required: true }],
    options: [
      ...LOCAL_EXECUTION_OPTIONS,
      { flags: '--input <json-or-file>', description: 'Input for an authored .flow.ts, inline JSON or a file path' },
      { flags: '--bucket <file-bucket-uri>', description: 'File bucket to fetch a sealed bundle from' },
      { flags: '--reuse-from <run-id>', description: 'Reuse memoized step outputs from an earlier run' },
      { flags: '--cloud', description: 'Submit to Agent Relay Cloud instead of running locally' },
      { flags: '--wait', description: 'With --cloud, poll until the hosted run reaches a terminal state' },
      {
        flags: '--sync-code',
        description: 'With --cloud, upload the working directory as the run’s tree; pull results back with `flows sync`',
      },
      {
        flags: '--no-connect',
        description: 'With --cloud, refuse a missing integration instead of offering to connect it',
      },
    ],
    variants: ['run', 'cloud-run'],
  },
  {
    name: 'schedule',
    description: 'Register a flow to run in Cloud on a cron or interval, or on the one it declares',
    args: [{ name: 'flow', description: 'flow.yaml or flow.ts submitted on every fire', required: true }],
    options: [
      {
        flags: '--cron <expr>',
        description: 'Cron expression to fire on; with neither this nor --every, the flow’s own schedule.* handler supplies it',
      },
      { flags: '--every <duration>', description: 'Fixed cadence, as <n><s|m|h|d>; not valid with --cron' },
      { flags: '--tz <iana>', description: 'IANA timezone the cron is read in' },
      { flags: '--input <json-or-file>', description: 'Input for an authored .flow.ts, inline JSON or a file path' },
      { flags: '--name <name>', description: 'Name for the schedule' },
      NO_CONNECT_OPTION,
      JSON_OPTION,
    ],
    variants: ['schedule'],
  },
  {
    name: 'schedules',
    description: 'List this workspace’s Cloud schedules',
    options: [JSON_OPTION],
    variants: ['schedules'],
  },
  {
    name: 'serve-webhook',
    description: 'Run the local webhook receiver that writes provider deliveries into the trigger inbox',
    options: [
      DATA_DIR_OPTION,
      { flags: '--port <port>', description: 'Port to listen on, bound to 127.0.0.1; required' },
      { flags: '--allow <names>', description: 'Comma-separated flow names this receiver admits' },
    ],
    variants: ['serve-webhook'],
  },
  {
    name: 'sync',
    description: 'Apply a hosted run’s code changes to a local tree (replaces `agent-relay cloud sync`)',
    args: [{ name: 'run-id', description: 'Hosted run id whose patch to apply', required: true }],
    options: [
      JSON_OPTION,
      { flags: '--dry-run', description: 'Print the patch and apply nothing' },
      { flags: '--dir <path>', description: 'Tree to apply the patch to', defaultValue: '.' },
    ],
    variants: ['sync'],
  },
  {
    name: 'tick',
    description: 'Interval scheduler: launch a flow on a fixed local cadence',
    subcommands: [
      {
        name: 'start',
        description: 'Start ticking in the foreground',
        args: [{ name: 'spec', description: 'Flow spec.json to launch each tick', required: true }],
        options: [
          DATA_DIR_OPTION,
          { flags: '--schedule-id <id>', description: 'Stable id identifying this schedule' },
          { flags: '--interval-ms <ms>', description: 'Milliseconds between ticks' },
          { flags: '--epoch-ms <ms>', description: 'Epoch the tick grid is aligned to' },
          { flags: '--max-catch-up <n>', description: 'Most missed ticks to replay after a gap' },
          { flags: '--poll-interval-ms <ms>', description: 'Milliseconds between schedule polls' },
        ],
      },
    ],
    variants: ['tick'],
  },
  {
    name: 'undeploy',
    description: 'Remove a hosted trigger listener',
    args: [{ name: 'deployment-id', description: 'Deployment id to remove', required: true }],
    options: [JSON_OPTION],
    variants: ['undeploy'],
  },
  {
    name: 'unschedule',
    description: 'Remove a Cloud schedule, so it stops firing',
    args: [{ name: 'schedule-id', description: 'Schedule id to remove', required: true }],
    options: [JSON_OPTION],
    variants: ['unschedule'],
  },
] as const satisfies readonly CliVerbSpec[];

/**
 * Every `ParsedArgs` variant claimed by some verb in {@link CLI_VERBS}.
 *
 * Widened from the table rather than written down, so it tracks the table.
 */
type DeclaredVariant = (typeof CLI_VERBS)[number]['variants'][number];

/**
 * Compile-time drift guard, the half a runtime test cannot cover.
 *
 * Adding a variant to `ParsedArgs` without giving some verb a claim on it
 * leaves `Exclude<ParsedArgs['command'], DeclaredVariant>` non-`never`, and
 * this assignment stops compiling. The reverse direction catches a table entry
 * naming a variant that no longer exists.
 */
type AssertNever<T extends never> = T;
export type _EveryVariantIsDeclared = AssertNever<Exclude<ParsedArgs['command'], DeclaredVariant>>;
export type _EveryDeclaredVariantExists = AssertNever<Exclude<DeclaredVariant, ParsedArgs['command']>>;

/**
 * The verbs `parseArgs` accepts. A token outside this set is refused before any
 * per-verb parser sees it, which is what keeps dispatch and {@link CLI_VERBS}
 * from drifting apart.
 */
export const CLI_VERB_NAMES: ReadonlySet<string> = new Set(CLI_VERBS.map((verb) => verb.name));
