import { helperProviders, unsupportedHelperMemberMessage } from '@relayflows/surface/runtime';
import { codeOnly } from './source-scan.js';
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
  const diagnostics: PreflightDiagnostic[] = [];
  for (const provider of helperProviders) {
    const { namespace, supported } = provider;
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
      ? unavailableMembers(root, namespace, provider.resources, body) : [];
    if (!supported) {
      diagnostics.push({ severity: 'refusal', kind: 'helper_provider.unsupported',
        message: `f.${namespace} has no upstream relayfile writeback client.` });
    } else if (missing.length > 0) {
      diagnostics.push({ severity: 'refusal', kind: 'helper_provider.unsupported',
        message: unsupportedHelperMemberMessage(provider.provider, missing[0]!, provider.resources) });
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
 * Members read off `f.<namespace>` in the body that the provider does not
 * expose, in source order.
 *
 * Only what is statically evident counts: a direct `.member` or `['member']`
 * on the context parameter this body actually declares, matched against
 * `codeOnly`, where comments and data strings are blanked but a literal in
 * property-key position is not. A computed name is not decided here — the
 * surface's own property guard refuses it at call time.
 */
function unavailableMembers(
  root: string | undefined, namespace: string, resources: readonly string[], body: string,
): string[] {
  if (root === undefined) return [];
  const access = new RegExp(
    `(?:^|[^\\w$.])${root}\\s*(?:\\.\\s*${namespace}|\\[\\s*['"]${namespace}['"]\\s*\\])`
      + `\\s*(?:\\.\\s*([\\w$]+)|\\[\\s*['"]([\\w$]+)['"]\\s*\\])`, 'gu');
  const found: string[] = [];
  for (const match of codeOnly(body).matchAll(access)) {
    const member = match[1] ?? match[2]!;
    if (!resources.includes(member) && !found.includes(member)) found.push(member);
  }
  return found;
}
