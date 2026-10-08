import { helperProviders } from '@relayflows/surface/runtime';
import type { PreflightResult, PreflightDiagnostic } from './preflight.js';
import { helperNamespacesUsed } from './helper-reference.js';
import { helperOperationUse } from './helper-operation-use.js';

/** Static discovery never executes the body; dynamic aliases are checked at call time. */
export function preflightHelpers(
  definition: { header?: { tools?: Readonly<Record<string, unknown>> }; body?: Function },
  facts: { slackToken?: string; slackMount?: boolean; slackMock?: boolean;
    providers?: Readonly<Record<string, { mount: boolean; mock: boolean; token?: string }>> },
): PreflightResult {
  const body = typeof definition.body === 'function' ? Function.prototype.toString.call(definition.body) : '';
  const parameter = body.match(/^(?:async\s+)?(?:function\s*\*?\s*(?:[\w$]+)?\s*)?(?:\(\s*([\w$]+)|([\w$]+)\s*=>|\*?\s*[\w$]+\s*\(\s*([\w$]+))/u);
  // NOT regex-escaped: this is compared to an AST Identifier name, so a legal
  // parameter like `f$` must stay `f$`. Escaping it hid every helper call.
  const root = parameter?.[1] ?? parameter?.[2] ?? parameter?.[3];
  const diagnostics: PreflightDiagnostic[] = [];
  // Read from a parse, not from the text: a helper named inside a string,
  // comment, template quasi or regex is not used, and refusing on one demands
  // a mount the flow never touches.
  const referenced = root === undefined ? new Set<string>() : helperNamespacesUsed(body, root);
  // f.notion.appendBlock has no writeback route. It is attributed precisely only
  // while f.notion is used directly; once it is aliased, passed on or reached by a
  // computed name, the call cannot be ruled out and check refuses, saying why.
  // Without a named context parameter (destructured, say) nothing can be
  // attributed, so a declared Notion flow cannot rule the call out.
  const notionAppend = body.trim() === '' ? 'absent'
    : root === undefined ? 'unprovable'
      : helperOperationUse(body, root, 'notion', 'appendBlock');
  const appendsNotionBlock = notionAppend !== 'absent';
  const notionAppendInferred = notionAppend === 'unprovable';
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
    }
    // Missing local mounts must not hide an operation unsupported on Cloud too.
    if (supported && provider === 'notion' && !fact.mock && appendsNotionBlock) {
      diagnostics.push({ severity: 'refusal', kind: 'helper_provider.unsupported',
        message: 'f.notion.appendBlock is mock-only: the Notion adapter has no append-block writeback route.'
          + (notionAppendInferred ? ' f.notion is aliased, passed on or called through a computed name in this body, so the call cannot be ruled out;'
            + ' call f.notion methods directly by name on a named context parameter (f.notion.createPage(...)) so flows check can see which ones run.' : '') });
    }
  }
  return { ok: diagnostics.length === 0, gates: [], resolutions: [], diagnostics };
}
