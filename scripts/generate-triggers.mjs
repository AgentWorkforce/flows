import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(join(root, 'packages/sdk/package.json'));
const { parse } = require('yaml');
const { values } = parseArgs({ options: {
  'adapters-dir': { type: 'string' },
  'out-dir': { type: 'string', default: join(root, 'packages/surface/src/triggers') },
  check: { type: 'boolean', default: false },
} });

/**
 * Three sources, applied in this order, each keyed by provider:
 *
 * 1. The core fallback mappings (`mappings/*.mapping.yaml` in the published
 *    `@relayfile/adapter-core`, or `packages/core/mappings` in a checkout).
 * 2. Each adapter's own mapping (`mappings/adapters/*.mapping.yaml` in the
 *    package since adapter-core 0.5.26, or `packages/<adapter>/*.mapping.yaml`
 *    in a checkout). An adapter-local `webhooks:` block supersedes the core
 *    fallback for that provider as a whole, so `github.pull_request(action)`
 *    keeps its `extract`-derived signature.
 * 3. The trigger catalog (`@relayfile/adapter-core/triggers`,
 *    `KNOWN_TRIGGER_CATALOG`), which every adapter feeds through
 *    `supportedEvents()` — the events the adapter actually delivers, whether
 *    or not it ships mapping YAML. A mapping's `webhooks:` block describes
 *    payload shape for some of those events, not the full set (gitlab maps
 *    8 of the 47 it delivers), so catalog events are added to every provider
 *    with the plain `(filter?)` signature, and an event the mapping also
 *    declares keeps the mapping's `extract`-aware signature.
 *
 * Every provider a relayfile adapter can deliver therefore gets a namespace
 * covering everything ingress will accept for it.
 */
const mappings = new Map();
/** provider → events declared by a mapping (they own their method names). */
const declared = new Map();
const catalogProviders = new Set();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => value.replaceAll(/[^A-Za-z0-9_$]/g, '_');
// Names the surface already exports or the generator itself owns.
const RESERVED_NAMESPACES = new Set(['index', 'providerEventTypes', 'webhook', 'flow', 'schedule', 'default']);

function readMappings(directory) {
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith('.mapping.yaml')) continue;
    const mapping = parse(readFileSync(join(directory, name), 'utf8'), { uniqueKeys: true });
    assert(object(mapping), `Invalid mapping: ${name}`);
    const provider = mapping.adapter?.name ?? mapping.provider ?? name.replace('.mapping.yaml', '');
    assert(typeof provider === 'string' && /^[a-z][a-z0-9-]*$/.test(provider), `Invalid provider: ${provider}`);
    if (mapping.webhooks === undefined) continue;
    assert(object(mapping.webhooks), `Invalid webhooks: ${name}`);
    for (const [event, definition] of Object.entries(mapping.webhooks)) {
      assert(event.length > 0 && object(definition), `Invalid webhook: ${name}/${event}`);
      assert(definition.extract === undefined || (Array.isArray(definition.extract)
        && definition.extract.every(field => typeof field === 'string')), `Invalid extract: ${name}/${event}`);
    }
    // Adapter-local mappings supersede the core's fallback mappings as a whole.
    mappings.set(provider, { ...mapping.webhooks });
    declared.set(provider, new Set(Object.keys(mapping.webhooks)));
  }
}

function readCatalog(catalog) {
  assert(object(catalog), 'Invalid trigger catalog');
  for (const [provider, events] of Object.entries(catalog)) {
    assert(/^[a-z][a-z0-9-]*$/.test(provider), `Invalid catalog provider: ${provider}`);
    assert(Array.isArray(events) && events.every(event => typeof event === 'string' && event.length > 0),
      `Invalid catalog events: ${provider}`);
    if (!events.length) continue;
    const merged = mappings.get(provider) ?? {};
    const hadMapping = Object.keys(merged).length > 0;
    // Union: a mapping-declared event keeps its signature; the rest of what
    // the adapter delivers is added with the plain filter signature.
    for (const event of events) if (!Object.hasOwn(merged, event)) merged[event] = {};
    mappings.set(provider, merged);
    if (!hadMapping) catalogProviders.add(provider);
  }
}

if (values['adapters-dir']) {
  const adapters = resolve(values['adapters-dir']);
  const packages = join(adapters, 'packages');
  readMappings(join(packages, 'core/mappings'));
  for (const entry of readdirSync(packages, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && entry.name !== 'core') readMappings(join(packages, entry.name));
  }
  const catalog = join(packages, 'core/src/triggers/catalog.generated.json');
  if (existsSync(catalog)) readCatalog(JSON.parse(readFileSync(catalog, 'utf8')));
} else {
  // Pinned SDK dependency includes the upstream mapping YAML and the trigger
  // catalog in its npm tarball.
  const core = dirname(require.resolve('@relayfile/adapter-core/package.json'));
  readMappings(join(core, 'mappings'));
  readMappings(join(core, 'mappings', 'adapters'));
  readCatalog(require('@relayfile/adapter-core/triggers').KNOWN_TRIGGER_CATALOG);
}
assert([...mappings.values()].some(events => Object.keys(events).length), 'No webhook mappings found');

const header = '// GENERATED by scripts/generate-triggers.mjs — do not edit.\n';
const mdHeader = '<!-- GENERATED by scripts/generate-triggers.mjs — do not edit. -->\n';
const files = new Map();
const exports = [];
const registry = {};
const namespaces = new Set();
const summary = [];
for (const [provider, events] of [...mappings].sort(([a], [b]) => a.localeCompare(b))) {
  if (!Object.keys(events).length) continue;
  const namespace = identifier(provider);
  assert(!namespaces.has(namespace) && !RESERVED_NAMESPACES.has(namespace), `Provider name collision: ${provider}`);
  namespaces.add(namespace);
  const methods = [];
  const names = new Set();
  const eventNames = Object.keys(events).sort();
  const add = (name, code) => {
    assert(!names.has(name), `Trigger name collision: ${provider}.${name}`);
    names.add(name);
    methods.push(code);
  };
  // Two upstream names can mangle to one identifier (slack publishes both
  // `reaction.added` and `reaction_added`). A mapping-declared event owns the
  // method; a catalog event that would collide with it gets no method but
  // stays in the registry, so `flows check` and ingress still accept
  // `webhook(provider, { provider, type })` for it. Two mapping-declared
  // events colliding is still an error, as before.
  const methodless = [];
  const owned = declared.get(provider) ?? new Set();
  // Mapping-declared events first so they win any identifier collision.
  const ordered = [...eventNames].sort((a, b) => (owned.has(b) ? 1 : 0) - (owned.has(a) ? 1 : 0) || a.localeCompare(b));
  for (const event of ordered) {
    const name = identifier(event);
    assert(/^[A-Za-z_$]/.test(name), `Invalid event identifier: ${event}`);
    if (names.has(name) && !owned.has(event)) { methodless.push(event); continue; }
    const prefix = `providerTrigger(${JSON.stringify(provider)}, ${JSON.stringify(event)}`;
    if (events[event].extract?.includes('action')) {
      add(name, `  ${name}(action?: string) {\n    return ${prefix}, action === undefined ? undefined : { action: triggerArgument(action, "action") });\n  },`);
    } else {
      add(name, `  ${name}(filter?: WebhookFilter) {\n    return ${prefix}, filter);\n  },`);
    }
  }
  // Author-facing shorthand for Slack's raw Events API payloads. These are
  // emitted only when the corresponding mapping capability exists.
  if (provider === 'slack' && events.message) {
    add('mention', '  mention(channel: string) {\n    return providerTrigger("slack", "app_mention", { channel: triggerArgument(channel, "channel") });\n  },');
    if (!eventNames.includes('app_mention')) eventNames.push('app_mention');
  }
  if (provider === 'slack' && events.reaction_added) {
    add('reaction', '  reaction(emoji: string) {\n    return providerTrigger("slack", "reaction_added", { reaction: triggerArgument(emoji, "emoji") });\n  },');
  }
  const needsArgument = methods.some(method => method.includes('triggerArgument('));
  const needsFilter = methods.some(method => method.includes('WebhookFilter'));
  files.set(`${provider}.ts`, `${header}\nimport { providerTrigger${needsArgument ? ', triggerArgument' : ''} } from "../provider-trigger.js";\n`
    + (needsFilter ? 'import type { WebhookFilter } from "../triggers.js";\n' : '')
    + `\nexport const ${namespace} = Object.freeze({\n${methods.join('\n')}\n});\n`);
  exports.push(`export { ${namespace} } from "./${provider}.js";`);
  registry[provider] = eventNames.sort();
  summary.push({ provider, namespace, events: eventNames.length, source: catalogProviders.has(provider) ? 'catalog' : 'mapping', methodless });
}
files.set('index.ts', `${header}\n${exports.join('\n')}\n\n`
  + '/** Exact upstream event names, plus the generated Slack mention shorthand. */\n'
  + `export const providerEventTypes = Object.freeze({\n${Object.entries(registry).map(([provider, events]) =>
    `  ${JSON.stringify(provider)}: Object.freeze(${JSON.stringify(events)} as const),`).join('\n')}\n});\n`);
files.set('PROVIDERS.md', `${mdHeader}# Provider trigger namespaces\n\n`
  + `${summary.length} providers, ${summary.reduce((n, s) => n + s.events, 0)} events. `
  + '`mapping` rows come from the adapter\'s `webhooks:` block (payload-aware signatures); '
  + '`catalog` rows come from `KNOWN_TRIGGER_CATALOG` (`supportedEvents()`) only. Every provider also includes its catalog events, so the count is what ingress delivers.\n\n'
  + '| Provider | Namespace | Events | Source | Registry-only events |\n|---|---|---:|---|---|\n'
  + summary.map(s => `| \`${s.provider}\` | \`${s.namespace}\` | ${s.events} | ${s.source} | ${s.methodless.map(e => `\`${e}\``).join(', ')} |`).join('\n')
  + '\n\nRegistry-only events share an identifier with another event of the same provider; subscribe with `webhook(provider, { provider, type })`.\n');

const destination = resolve(values['out-dir']);
const generated = name => /\.(?:ts|md)$/.test(name) && name !== 'README.md';
if (values.check) {
  const actual = existsSync(destination) ? readdirSync(destination).filter(generated) : [];
  const stale = [...new Set([...files.keys(), ...actual])].filter(name => !files.has(name)
    || !existsSync(join(destination, name)) || readFileSync(join(destination, name), 'utf8') !== files.get(name));
  assert.equal(stale.length, 0, `Generated triggers drifted: ${stale.join(', ')}`);
} else {
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(destination)) {
    if (generated(name) && !files.has(name)) {
      const content = readFileSync(join(destination, name), 'utf8');
      if (content.startsWith(header) || content.startsWith(mdHeader)) rmSync(join(destination, name));
    }
  }
  for (const [name, content] of files) writeFileSync(join(destination, name), content);
}
console.log(`${values.check ? 'Checked' : 'Generated'} ${summary.length} provider trigger modules`);
