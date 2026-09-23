import { assertBaseCompatible } from './flow-extension-compat.js';
import { resolveExtensionSubmission, type FlowExtensionSubmission } from './flow-extension-submit.js';
import { canonicalPluginRef, parseCanonicalPluginRef } from './plugin-source.js';

export interface BabysitterCatalogPin {
  readonly ref: string;
  readonly digest: string;
  readonly manifestSha256: string;
}

/** Export reviewed bytes, never execute the entry or infer runtime readiness. */
export async function exportBabysitterCatalogBundle(
  pin: BabysitterCatalogPin,
  options: Parameters<typeof resolveExtensionSubmission>[1] = {},
): Promise<FlowExtensionSubmission> {
  const source = parseCanonicalPluginRef(pin.ref);
  if (canonicalPluginRef(source) !== pin.ref || source.owner !== 'AgentWorkforce' || source.repo !== 'flows') {
    throw new Error('Babysitter catalog source must be a canonical AgentWorkforce/flows commit ref.');
  }
  if (![pin.digest, pin.manifestSha256].every(value => /^[0-9a-f]{64}$/.test(value))) {
    throw new Error('Expected reviewed bundle and manifest SHA-256 digests.');
  }
  const bundle = await resolveExtensionSubmission(pin.ref, options);
  if (bundle.ref !== pin.ref || bundle.digest !== pin.digest || bundle.manifestSha256 !== pin.manifestSha256) {
    throw new Error('Babysitter artifact differs from the reviewed pin.');
  }
  const manifest = bundle.manifest;
  if (manifest.name !== 'babysitter') throw new Error('Expected the babysitter extension.');
  assertBaseCompatible(manifest, { name: 'software-factory' });
  const p = manifest.permissions;
  const exactly = (values: readonly string[], expected: string) => values.length === 1 && values[0] === expected;
  if (!exactly(p.integrations, 'github') || !exactly(p.harnesses, 'codex') || p.mcp.length !== 0
    || !exactly(p.writes, 'cloud:babysitter-turn')) {
    throw new Error('Babysitter requires only github, codex, no MCP, and cloud:babysitter-turn.');
  }
  if (!manifest.extends.handlers || manifest.extends.hooks.length !== 0) {
    throw new Error('Native Babysitter must contribute handlers only, without merge hooks.');
  }
  // The validator normalizes optional source fields. The wire manifest must
  // remain the actual digest-bound JSON so Cloud can independently parse it.
  const file = bundle.files.find(entry => entry.path === 'flows-plugin.json')!;
  const rawManifest = JSON.parse(Buffer.from(file.content, file.encoding).toString('utf8'));
  return { ...bundle, manifest: rawManifest };
}
