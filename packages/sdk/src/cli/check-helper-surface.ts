import { helperProviders } from '@relayflows/surface/runtime';
import type { PreflightDiagnostic } from '../preflight.js';
import type { CheckWarningDiagnostic } from './check.js';

const mountKinds = new Set([
  'helper_slack.credential_missing', 'helper_slack.mount_required',
  'helper_provider.mount_required', 'helper_mount_required',
]);

/** Restate local mount failures for inspection only; execution stays strict. */
export function helperCredentialDiagnostics(diagnostics: readonly PreflightDiagnostic[]): {
  diagnostics: Array<PreflightDiagnostic | CheckWarningDiagnostic>;
  downgraded: boolean;
} {
  const result: Array<PreflightDiagnostic | CheckWarningDiagnostic> = [];
  const seen = new Set<string>();
  for (const diagnostic of diagnostics) {
    const helper = diagnostic.severity === 'refusal' && mountKinds.has(diagnostic.kind)
      ? helperProviders.find(({ namespace, provider }) =>
        diagnostic.message.startsWith(`f.${namespace} requires `)
        || diagnostic.message.startsWith(`${provider} helper requires `))
      : undefined;
    // Unknown diagnostic shapes remain refusals rather than silently passing.
    if (helper === undefined) {
      result.push(diagnostic);
      continue;
    }
    if (seen.has(helper.provider)) continue;
    seen.add(helper.provider);
    result.push({
      severity: 'warning', kind: 'helper_credential_unresolved',
      message: `f.${helper.namespace} needs a ${helper.provider} mount, which is not available locally. `
        + 'flows schedule / flows deploy / flows run --cloud check the integration against your workspace at submit and refuse if Cloud cannot connect it. '
        + `A local flows run needs a relayfile ${helper.provider} mount (a ${helper.provider}/ directory under RELAYFILE_MOUNT_PATH) `
        + `or ${helper.mockEnv}=1, and refuses with [${diagnostic.kind}] without one.`,
    });
  }
  return { diagnostics: result, downgraded: seen.size > 0 };
}
