import { helperProviders } from '@relayflows/surface/runtime';
import { codeOnly, rebindsIdentifier } from './source-scan.js';
import type { PreflightResult, PreflightDiagnostic } from './preflight.js';

/** Static discovery never executes the body; dynamic aliases are checked at call time. */
export function preflightHelpers(
  definition: { header?: { tools?: Readonly<Record<string, unknown>> }; body?: Function },
  facts: { slackToken?: string; slackMount?: boolean; slackMock?: boolean;
    providers?: Readonly<Record<string, { mount: boolean; mock: boolean; token?: string }>> },
): PreflightResult {
  const body = typeof definition.body === 'function' ? Function.prototype.toString.call(definition.body) : '';
  const parameter = body.match(/^(?:async\s+)?(?:function(?:\s+[\w$]+)?\s*)?(?:\(\s*([\w$]+)|([\w$]+)\s*=>)/);
  const root = (parameter?.[1] ?? parameter?.[2])?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** End of the body's own parameter declaration, which is not a rebinding of itself. */
  const declared = parameter?.[0].length ?? 0;
  const diagnostics: PreflightDiagnostic[] = [];
  for (const catalogEntry of helperProviders) {
    // This SDK compiles against a PUBLISHED surface whose catalog predates
    // 'partial': its `supported` is boolean and it carries no `resources` or
    // `note`. Read the row structurally so the same source typechecks against
    // both catalog shapes; on the published one `resources` is simply absent.
    const provider = catalogEntry as {
      provider: string; namespace: string;
      supported: boolean | 'partial';
      resources?: readonly string[]; note?: string;
    };
    const { namespace, supported } = provider;
    const resources = provider.resources ?? [];
    const used = definition.header?.tools?.[namespace] === true
      || (root !== undefined && new RegExp(`(?:^|[^\\w$.])${root}\\s*(?:\\.\\s*${namespace}\\b|\\[\\s*['"]${namespace}['"]\\s*\\])`).test(body));
    if (!used) continue;
    const fact = facts.providers?.[provider.provider] ?? (provider.provider === 'slack'
      ? { mount: facts.slackMount, mock: facts.slackMock, token: facts.slackToken }
      : { mount: false, mock: false, token: undefined });
    // A resource the helper does not have is refused before the mount question
    // and regardless of mock mode: installing a mount cannot conjure a
    // writeback route that no client carries, and a body that would die on
    // `undefined is not a function` should say so with the names that do work.
    const missing = supported === 'partial'
      ? unavailableMembers(root, declared, namespace, resources, body) : [];
    if (!supported) {
      diagnostics.push({ severity: 'refusal', kind: 'helper_provider.unsupported',
        message: `f.${namespace} has no upstream relayfile writeback client.` });
    } else if (missing.length > 0) {
      diagnostics.push({ severity: 'refusal', kind: 'helper_provider.unsupported',
        message: unavailableMessage(namespace, missing[0]!, resources, provider.note) });
    } else if (!fact.mock && !fact.mount) {
      diagnostics.push({ severity: 'refusal',
        kind: provider.provider === 'slack' ? (fact.token?.trim() ? 'helper_slack.mount_required' : 'helper_slack.credential_missing') : 'helper_provider.mount_required',
        message: `f.${namespace} requires a relayfile ${provider.provider} mount; direct-token transport is not implemented.` });
    } else if (provider.provider === 'notion' && !fact.mock && /\.\s*appendBlock\b/.test(body)) {
      diagnostics.push({ severity: 'refusal', kind: 'helper_provider.unsupported',
        message: 'f.notion.appendBlock is mock-only: the Notion adapter has no append-block writeback route.' });
    }
  }
  return { ok: diagnostics.length === 0, gates: [], resolutions: [], diagnostics };
}

/**
 * The refusal wording for a helper member the provider does not have.
 *
 * The surface words the same refusal, in `unsupportedHelperMemberMessage`, for
 * the guard that catches a computed name at the call site. It is restated here
 * rather than imported because this SDK source is installed against a
 * PUBLISHED surface — importing a named export the pinned version has not
 * shipped fails the whole module at load, before preflight can run at all. The
 * catalog data behind the wording (`resources`, `note`) degrades quietly by
 * comparison: an older catalog carries no `'partial'` entry, so this refusal
 * simply does not arise. `tests/helper-partial-support.test.ts` pins the two
 * wordings to the same string.
 */
function unavailableMessage(
  namespace: string, member: string, available: readonly string[], note: string | undefined,
): string {
  return `f.${namespace}.${member} is unavailable; available resources: ${[...available].sort().join(', ')}.`
    + (note === undefined ? '' : ` ${note}`);
}

/**
 * Members read off `f.<namespace>` in the body that the provider does not
 * expose, in source order.
 *
 * Only what is statically evident counts: a direct `.member` or `['member']`
 * on the context parameter this body actually declares, matched against
 * `codeOnly`, where comments, data strings and regex literals are blanked but
 * a literal in property-key position is not. A computed name is not decided
 * here — the surface's own property guard refuses it at call time — and
 * neither is a body that binds the parameter's name again, where `f.gitlab`
 * need not be the flow context at all.
 */
function unavailableMembers(
  root: string | undefined, declared: number, namespace: string, resources: readonly string[], body: string,
): string[] {
  if (root === undefined) return [];
  const code = codeOnly(body);
  if (rebindsIdentifier(code, root, declared)) return [];
  const access = new RegExp(
    `(?:^|[^\\w$.])${root}\\s*(?:\\.\\s*${namespace}|\\[\\s*['"]${namespace}['"]\\s*\\])`
      + `\\s*(?:\\.\\s*([\\w$]+)|\\[\\s*['"]([\\w$]+)['"]\\s*\\])`, 'gu');
  const found: string[] = [];
  for (const match of code.matchAll(access)) {
    const member = match[1] ?? match[2]!;
    if (!resolves(member, resources) && !found.includes(member)) found.push(member);
  }
  return found;
}

/**
 * Whether the guarded helper still resolves `member`.
 *
 * The surface's guard refuses only what is not `in` the bound object and is
 * neither `then` nor `toJSON`, so a partial helper keeps ordinary object
 * behavior: `f.gitlab.hasOwnProperty('comments')` returns `true` and
 * `f.gitlab.toJSON` reads as `undefined`. Preflight has to admit exactly the
 * same members, or `flows check` rejects introspection that runs. None of
 * these is dispatchable: `invokeHelper` resolves a verb with `Object.hasOwn`,
 * which no inherited name satisfies.
 */
function resolves(member: string, resources: readonly string[]): boolean {
  return resources.includes(member) || member === 'then' || member === 'toJSON'
    || Reflect.has(Object.prototype, member);
}
