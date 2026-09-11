import Ajv from 'ajv';
import { githubClient, linearClient, slackClient, type RelayTransport } from '@relayfile/relay-helpers';
import type { AgentStepSpec, KernelAgentStep, YamlHelperParams } from './spec.js';
import { canonicalize } from './canonical.js';
import { unknownKeyErrors } from './unknown-keys.js';

const string = { type: 'string', minLength: 1 };
const text = { type: 'string' };
const strings = { type: 'array', items: string };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  ({ type: 'object', properties, required, additionalProperties: false });
const target = object({ owner: string, repo: string, number: { type: 'integer', minimum: 1 } });
const issueChanges = { title: string, description: text, assigneeId: string, stateId: string,
  projectId: string, labelIds: strings, addedLabelIds: strings, removedLabelIds: strings };
const ajv = new Ajv({ allErrors: true });

function verb<P>(schema: object, invoke: (params: P, transport: RelayTransport) => Promise<unknown>) {
  const validate = ajv.compile(schema);
  return { validate, invoke: (params: unknown, transport: RelayTransport) => invoke(params as P, transport) };
}

/** Closed catalog: only write verbs with a declared argument schema can execute. */
const helpers = {
  slack: {
    post: verb<YamlHelperParams['slack']['post']>(object({ channel: string, text,
      opts: object({ replyTo: string }, []) }, ['channel', 'text']),
    (p, transport) => slackClient({ transport }).post(p.channel, p.text, p.opts)),
    dm: verb<YamlHelperParams['slack']['dm']>(object({ user: string, text }),
      (p, transport) => slackClient({ transport }).dm(p.user, p.text)),
    reply: verb<YamlHelperParams['slack']['reply']>(object({ channel: string, threadTs: string, text }),
      (p, transport) => slackClient({ transport }).reply(p.channel, p.threadTs, p.text)),
    react: verb<YamlHelperParams['slack']['react']>(object({ channel: string, messageTs: string, emoji: string }),
      (p, transport) => slackClient({ transport }).react(p.channel, p.messageTs, p.emoji)),
  },
  github: {
    comment: verb<YamlHelperParams['github']['comment']>(object({ target, body: text }),
      (p, transport) => githubClient({ transport }).comment(p.target, p.body)),
    createIssue: verb<YamlHelperParams['github']['createIssue']>(object({ owner: string, repo: string,
      title: string, body: text, labels: strings }, ['owner', 'repo', 'title', 'body']),
    (p, transport) => githubClient({ transport }).createIssue(p)),
    createPullRequest: verb<YamlHelperParams['github']['createPullRequest']>(object({ owner: string,
      repo: string, title: string, head: string, base: string, body: text, draft: { type: 'boolean' },
      author: { enum: ['app', 'user'] } }, ['owner', 'repo', 'title', 'head', 'base']),
    (p, transport) => githubClient({ transport }).createPullRequest(p)),
    closePullRequest: verb<YamlHelperParams['github']['closePullRequest']>(target,
      (p, transport) => githubClient({ transport }).closePullRequest(p)),
  },
  linear: {
    comment: verb<YamlHelperParams['linear']['comment']>(object({ issueId: string, body: text }),
      (p, transport) => linearClient({ transport }).comment(p.issueId, p.body)),
    createIssue: verb<YamlHelperParams['linear']['createIssue']>(object({ teamId: string, title: string,
      description: text, assigneeId: string, labelIds: strings, projectId: string, stateId: string }, ['teamId', 'title']),
    (p, transport) => linearClient({ transport }).createIssue(p)),
    updateIssue: verb<YamlHelperParams['linear']['updateIssue']>(object({ issueId: string,
      args: object(issueChanges, []) }),
    (p, transport) => linearClient({ transport }).updateIssue(p.issueId, p.args)),
  },
};

export type HelperCall = { [P in keyof YamlHelperParams]: { [V in keyof YamlHelperParams[P]]:
  { type: 'effect'; provider: P; verb: V; params: YamlHelperParams[P][V] }
}[keyof YamlHelperParams[P]] }[keyof YamlHelperParams];

const prefix = 'relayflows:helper:v1\n';
const commonFields = ['id', 'dependsOn', 'maxIterations', 'verification', 'output'] as const;
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function descriptor(provider: string, name: string) {
  if (!Object.hasOwn(helpers, provider)) throw new Error(`unknown helper provider "${provider}"`);
  const verbs = helpers[provider as keyof typeof helpers];
  if (!Object.hasOwn(verbs, name)) throw new Error(`unknown ${provider} helper verb "${name}"`);
  return (verbs as Record<string, ReturnType<typeof verb>>)[name]!;
}

function validateCall(value: unknown): HelperCall {
  if (!isObject(value) || value.type !== 'effect' || typeof value.provider !== 'string' || typeof value.verb !== 'string') {
    throw new Error('expected a helper effect call');
  }
  const extra = unknownKeyErrors(value, ['type', 'provider', 'verb', 'params'], 'helper');
  if (extra.length) throw new Error(extra.join('; '));
  const entry = descriptor(value.provider, value.verb);
  if (!entry.validate(value.params)) {
    throw new Error(`${value.provider}.${value.verb}: ${ajv.errorsText(entry.validate.errors)}`);
  }
  return value as HelperCall;
}

/** Runs on the inert JSON snapshot, before ordinary step validation. */
export function expandYamlHelpers(spec: unknown): unknown {
  if (!isObject(spec) || !Array.isArray(spec.steps)) return spec;
  return { ...spec, steps: spec.steps.map((step, index) => {
    if (!isObject(step)) return step;
    const providers = Object.keys(helpers).filter(provider => Object.hasOwn(step, provider));
    if (!providers.length) {
      // Recompiling a canonical envelope must fail with the same compile error
      // contract as authoring it, before preflight or workers see it.
      helperCall(step);
      return step;
    }
    const at = `spec.steps[${index}]`;
    try {
      if (providers.length !== 1) throw new Error('expected exactly one helper provider per step');
      const provider = providers[0]!;
      const errors = unknownKeyErrors(step, [...commonFields, provider], at);
      if (errors.length) throw new Error(errors.join('; '));
      const verbs = step[provider];
      if (!isObject(verbs) || Object.keys(verbs).length !== 1) throw new Error(`${provider}: expected exactly one helper verb`);
      const name = Object.keys(verbs)[0]!;
      const call = validateCall({ type: 'effect', provider, verb: name, params: verbs[name] });
      const { [provider]: _, ...base } = step;
      return { ...base, type: 'agent', instruction: prefix + canonicalize(call),
        recoveryMode: 'reset', surfaces: { external: [`/${provider}`] } };
    } catch (error) {
      throw new Error(`${at}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }) };
}

/** The versioned instruction envelope survives canonical specs and journal resume. */
export function helperCall(step: Partial<AgentStepSpec | KernelAgentStep>): HelperCall | undefined {
  if (step.type !== 'agent' || typeof step.instruction !== 'string' || !step.instruction.startsWith(prefix)) return undefined;
  const call = validateCall(JSON.parse(step.instruction.slice(prefix.length)));
  if (!step.surfaces?.external?.includes(`/${call.provider}`)) throw new Error('helper effect is missing its declared external surface');
  return call;
}

export async function invokeHelper(call: HelperCall, transport: RelayTransport): Promise<unknown> {
  const validated = validateCall(call);
  return (await descriptor(validated.provider, validated.verb).invoke(validated.params, transport)) ?? null;
}
