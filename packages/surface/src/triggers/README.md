# Provider event triggers

```ts
import { flow, slack, github } from '@relayflows/surface';

export default flow('triage')
  .on(slack.mention('C123'), async (f, event) => { f.done('success'); })
  .on(slack.reaction('eyes'), async (f, event) => { f.done('success'); })
  .on(github.pull_request('opened'), async (f, event) => { f.done('success'); });
```

Provider namespaces also export from `@relayflows/surface/triggers` and
`@relayflows/surface/triggers/slack` (or `/github`). Declarations are immutable
webhook sources: their executor/inbox name is the provider, and their filter
matches the provider, event type, and requested payload fields. Register those
provider names in `flows.json`'s `executors` array for preflight.

`slack.mention(channel)` subscribes to Slack's `app_mention` event;
`slack.reaction(emoji)` subscribes to `reaction_added`. Arguments match provider
values exactly: use the channel ID and reaction name from the incoming event.
`github.pull_request(action)` filters `payload.action`; omitting the action
accepts every pull request event. Upstream mappings do not declare action enums,
so the action parameter is a string. Other generated methods accept an optional
recursive payload filter, for example `github.push({ ref: 'refs/heads/main' })`.

The receiver accepts `POST /providers/slack` with this JSON:

```json
{"type":"app_mention","payload":{"channel":"C123","text":"Please review"}}
```

It writes `{ "provider": "slack", "type": "app_mention", "payload": {...} }`
atomically to `inbox/slack/<id>.json`. The path supplies the provider; a conflicting
provider in the body or unknown event type is rejected. `payload` is the provider
event body (Slack's inner `event` object). The event names are the exact mapping
keys; dots and hyphens become underscores only in TypeScript method names.
Ingress expects this envelope, not a raw vendor HTTP delivery. Signature
verification and public ingress remain part of the deployment work tracked in
#301. Generic `POST /<name>` retains its existing arbitrary-JSON contract.

The SDK's `webhookTriggerSpec(id, source)` lowers a declaration to `TriggerSpec`
for `compileSpec`/`toKernelSpec`. Provision the resulting RunSpec in
`triggers/<provider>.json`, with executable steps, as in the existing webhook
executor. The watcher applies the generated filters, journals matching events,
deduplicates by inbox file ID, and archives consumed events. For example:

```ts
import { compileSpec, toKernelSpec, webhookTriggerSpec } from '@relayflows/sdk';
import { slack } from '@relayflows/surface';

const binding = toKernelSpec(compileSpec({
  version: '0.1.0', name: 'mentions',
  triggers: [webhookTriggerSpec('mention', slack.mention('C123'))],
  steps: [{ id: 'ack', type: 'deterministic', command: 'printf accepted' }],
})); // Write binding as JSON to triggers/slack.json before ingress starts.
```

Each provider inbox still binds one RunSpec. This extends E's declaration and
inbox contract; deploying TypeScript handler bodies remains the separate #301
binding step.

Generation requires the SDK's development dependencies. The default input is
the mapping YAML shipped in the pinned `@relayfile/adapter-core` dependency
(currently Slack and GitHub). A checkout supplies additional providers:

```sh
node scripts/generate-triggers.mjs
node scripts/generate-triggers.mjs --check
node scripts/generate-triggers.mjs --adapters-dir /path/to/relayfile-adapters
```

The generator reads `packages/core/mappings/*.mapping.yaml`, then each adapter's
`packages/<adapter>/*.mapping.yaml`; adapter-local mappings take precedence.
Only adapters with a nonempty `webhooks:` section produce modules. It never
imports or executes adapter code. Rebuild the surface and SDK after regeneration.
