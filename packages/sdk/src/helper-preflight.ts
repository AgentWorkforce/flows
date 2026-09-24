import { helperProviders } from '@relayflows/surface/runtime';
import type { PreflightResult, PreflightDiagnostic } from './preflight.js';
import { helperNamespacesUsed } from './helper-reference.js';

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
  // Read from a parse, not from the text: a helper named inside a string,
  // comment, template quasi or regex is not used, and refusing on one demands
  // a mount the flow never touches.
  const referenced = root === undefined ? new Set<string>() : helperNamespacesUsed(body, root);
  for (const { provider, namespace, supported } of helperProviders) {
    const used = definition.header?.tools?.[namespace] === true
      || referenced.has(namespace);
    if (!used) continue;
    const fact = facts.providers?.[provider] ?? (provider === 'slack'
      ? { mount: facts.slackMount, mock: facts.slackMock, token: facts.slackToken }
      : { mount: false, mock: false, token: undefined });
    if (!supported) {
      diagnostics.push({ severity: 'refusal', kind: 'helper_provider.unsupported',
        message: `f.${namespace} has no upstream relayfile writeback client.` });
    } else if (!fact.mock && !fact.mount) {
      diagnostics.push({ severity: 'refusal',
        kind: provider === 'slack' ? (fact.token?.trim() ? 'helper_slack.mount_required' : 'helper_slack.credential_missing') : 'helper_provider.mount_required',
        message: `f.${namespace} requires a relayfile ${provider} mount; direct-token transport is not implemented.` });
    } else if (provider === 'notion' && !fact.mock && /\.\s*appendBlock\b/.test(body)) {
      diagnostics.push({ severity: 'refusal', kind: 'helper_provider.unsupported',
        message: 'f.notion.appendBlock is mock-only: the Notion adapter has no append-block writeback route.' });
    }
  }
  return { ok: diagnostics.length === 0, gates: [], resolutions: [], diagnostics };
}
