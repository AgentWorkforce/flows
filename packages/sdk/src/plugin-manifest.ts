import { Ajv } from 'ajv';
import { snapshotJsonValue } from './json-value.js';

export const PLUGIN_FAILURE_KINDS = [
  'plugin_unknown', 'plugin_install_failed', 'plugin_manifest_missing',
  'plugin_manifest_invalid', 'plugin_preflight_missing', 'plugin_verb_unknown_primitive',
  'plugin_unsupported', 'plugin_credential_missing', 'plugin_server_unreachable',
] as const;
export type PluginFailureKind = typeof PLUGIN_FAILURE_KINDS[number];
export class PluginError extends Error {
  constructor(readonly code: PluginFailureKind, message: string) { super(message); }
}
export interface PluginVerb {
  namespace: string;
  method: string;
  lowersTo: 'run' | 'llm' | 'agent' | 'effect' | 'wait';
  args: Record<string, unknown>;
}
export interface PluginManifest {
  name: string;
  version: string;
  verbs: readonly PluginVerb[];
  triggers: readonly unknown[];
  gates: readonly unknown[];
  preflight: { credentials: readonly string[]; servers: readonly string[] };
}
const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const reserved = new Set(['run', 'llm', 'agent', 'human', 'dispatch', 'done', 'cloud', 'memory', 'mcp', 'slack', '__proto__', 'constructor', 'prototype', 'then']);
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string' && s.trim().length > 0);
export function pluginPackageName(name: string): string {
  const bare = name.replace(/^@flows\//, '');
  if (!/^helper-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(bare)) {
    throw new PluginError('plugin_manifest_invalid', 'Expected helper-<name> or @flows/helper-<name>.');
  }
  return `@flows/${bare}`;
}
export function validatePluginManifest(input: unknown, packageName?: string): PluginManifest {
  let v: unknown;
  try { v = snapshotJsonValue(input, 'plugin manifest'); }
  catch { throw new PluginError('plugin_manifest_invalid', 'Plugin manifest must be JSON data.'); }
  const invalid = (message: string): never => { throw new PluginError('plugin_manifest_invalid', message); };
  if (!object(v)) return invalid('Expected a plugin manifest object.');
  if (!Object.hasOwn(v, 'preflight')) throw new PluginError('plugin_preflight_missing', 'Plugin must declare preflight.');
  if (typeof v.name !== 'string' || typeof v.version !== 'string' || !v.version.trim()) return invalid('Plugin name and version are required.');
  const resolved = pluginPackageName(v.name);
  if (packageName !== undefined && resolved !== packageName) return invalid('Plugin name does not match its package.');
  if (!Array.isArray(v.verbs) || !Array.isArray(v.triggers) || !Array.isArray(v.gates)) return invalid('Expected verbs, triggers, and gates arrays.');
  if (!object(v.preflight) || !strings(v.preflight.credentials) || !strings(v.preflight.servers)) return invalid('Preflight requires credentials and servers arrays.');
  if (!v.preflight.credentials.every(s => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s))) return invalid('Invalid credential environment variable.');
  for (const server of v.preflight.servers) {
    try { if (!['http:', 'https:'].includes(new URL(server).protocol)) return invalid('Servers must be HTTP(S) URLs.'); }
    catch { return invalid('Servers must be HTTP(S) URLs.'); }
  }
  const seen = new Set<string>();
  const ajv = new Ajv({ strict: false });
  for (const verb of v.verbs) {
    if (!object(verb) || typeof verb.namespace !== 'string' || typeof verb.method !== 'string'
      || !identifier.test(verb.namespace) || !identifier.test(verb.method)
      || reserved.has(verb.namespace) || ['__proto__', 'constructor', 'prototype', 'then'].includes(verb.method)) return invalid('Invalid or reserved plugin verb.');
    if (!['run', 'llm', 'agent', 'effect', 'wait'].includes(String(verb.lowersTo))) {
      throw new PluginError('plugin_verb_unknown_primitive', `Unknown primitive for ${verb.namespace}.${verb.method}.`);
    }
    if (!object(verb.args)) return invalid('Verb args must be a JSON Schema.');
    try { ajv.compile(verb.args); } catch { return invalid('Invalid verb argument JSON Schema.'); }
    const key = `${verb.namespace}.${verb.method}`;
    if (seen.has(key)) return invalid(`Duplicate verb ${key}.`);
    seen.add(key);
  }
  return v as unknown as PluginManifest;
}
export function assertSupportedPlugin(manifest: PluginManifest): void {
  if (manifest.triggers.length || manifest.gates.length || manifest.verbs.some(v => v.lowersTo !== 'effect')) {
    throw new PluginError('plugin_unsupported', 'This slice supports effect verbs; trigger, gate, run, llm, agent and wait dispatch are follow-ups.');
  }
}
