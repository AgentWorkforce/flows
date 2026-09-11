import { snapshotJsonValue } from './json-value.js';

export const SCOPE_MODES = ['readonly', 'readwrite', 'append'] as const;
export type ScopeMode = (typeof SCOPE_MODES)[number];
export type ScopeGrants = string | readonly string[];

/** Inert path-prefix permission; paths are relative to the named mount. */
export interface ScopeDescriptor {
  mount: string;
  path: string;
  mode: ScopeMode;
}

/** Facts supplied by relayfile's mount manifest, never an author-side ACL. */
export type MountRegistry = Readonly<Record<string, readonly {
  path: string;
  modes: readonly ScopeMode[];
}[]>>;

export interface ScopeDeclaration {
  source: string;
  stepId?: string;
  grant: string;
  scope: ScopeDescriptor;
}

export interface ScopeRefusal {
  severity: 'refusal';
  kind: 'scope_syntax_invalid' | 'mount_unknown' | 'scope_ungrantable';
  message: string;
  source: string;
  stepId?: string;
  grant?: string;
  scope?: ScopeDescriptor;
}

export interface ScopeCompilation {
  scopes: ScopeDeclaration[];
  diagnostics: ScopeRefusal[];
}

export interface ScopeInput {
  workspace?: ScopeGrants;
  tools?: { fs?: ScopeGrants };
  steps?: readonly { id: string; workspace?: ScopeGrants; tools?: { fs?: ScopeGrants } }[];
}

/** Reject ambiguous or traversing paths instead of normalizing permissions. */
export function isScopePath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0
    && path.split('/').every(part => /^[A-Za-z0-9._-]+$/.test(part)
      && part !== '.' && part !== '..');
}

export function parseScopeGrant(grant: string): ScopeDescriptor | undefined {
  const match = /^([A-Za-z0-9_-]+)\/(.+):\s*(readonly|readwrite|append)$/.exec(grant);
  if (match === null || match[0] !== grant || !isScopePath(match[2])) return undefined;
  return { mount: match[1]!, path: match[2]!, mode: match[3] as ScopeMode };
}

/** One pure pass collects every declaration error before any live probe. */
export function compileScopes(input: ScopeInput, mounts?: MountRegistry): ScopeCompilation {
  const result: ScopeCompilation = { scopes: [], diagnostics: [] };
  // Public callers may be JS: never run a getter while collecting permissions.
  const flow = snapshotJsonValue(input, 'scope declarations') as unknown as ScopeInput;
  function collect(value: unknown, source: string, stepId?: string): void {
    if (value === undefined) return;
    const location = { source, ...(stepId === undefined ? {} : { stepId }) };
    const grants = Array.isArray(value) ? value : [value];
    for (const grant of grants) {
      const scope = typeof grant === 'string' ? parseScopeGrant(grant) : undefined;
      if (scope === undefined) {
        result.diagnostics.push({
          ...location, severity: 'refusal', kind: 'scope_syntax_invalid',
          ...(typeof grant === 'string' ? { grant } : {}),
          message: `${source}: expected "<mount>/<path>: readonly|readwrite|append" with a canonical path prefix.`,
        });
        continue;
      }
      const declaration = { ...location, grant: grant as string, scope };
      result.scopes.push(declaration);
      if (mounts === undefined) continue; // Compiler does not invent environment facts.
      if (!Object.hasOwn(mounts, scope.mount)) {
        result.diagnostics.push({
          ...declaration, severity: 'refusal', kind: 'mount_unknown',
          message: `${source}: mount "${scope.mount}" is not present in the relayfile mount manifest.`,
        });
      } else if (!mounts[scope.mount]!.some(available =>
        available.modes.includes(scope.mode)
        && (scope.path === available.path || scope.path.startsWith(`${available.path}/`)))) {
        result.diagnostics.push({
          ...declaration, severity: 'refusal', kind: 'scope_ungrantable',
          message: `${source}: relayfile cannot grant "${grant}" from the mount's available path permissions.`,
        });
      }
    }
  }
  collect(flow.workspace, 'workspace');
  collect(flow.tools?.fs, 'tools.fs');
  for (const step of flow.steps ?? []) {
    collect(step.workspace, `step "${step.id}".workspace`, step.id);
    collect(step.tools?.fs, `step "${step.id}".tools.fs`, step.id);
  }
  return result;
}
