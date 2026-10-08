import { loadAuthoredFlow } from '../authored-flow-loader.js';
import { PluginError } from '../plugin-manifest.js';
import { checkSlackHelpers } from '../slack-preflight.js';
import { inputFailureReport, type CheckInvocation, type CheckExecution } from './check.js';

import { helperCredentialDiagnostics } from './check-helper-surface.js';

/** Imports the definition, but never executes arbitrary authored body code. */
export async function checkHelperBody(path: string, invocation: CheckInvocation = {}): Promise<CheckExecution> {
  try {
    const { handle, getDefinition } = await loadAuthoredFlow(path);
    const report = checkSlackHelpers(getDefinition(handle));
    const diagnostics = invocation.warnUnresolvedHelperCredential === true
      ? helperCredentialDiagnostics(report.diagnostics).diagnostics : report.diagnostics;
    return { report: { ...report, path, diagnostics,
      ok: !diagnostics.some(diagnostic => diagnostic.severity === 'refusal') } };
  } catch (error) {
    if (error instanceof PluginError) {
      return { report: inputFailureReport({ kind: error.code, message: error.message }, path) };
    }
    return { report: inputFailureReport({ kind: 'invalid_spec',
      message: error instanceof Error ? error.message : 'Could not import authored flow.' }, path) };
  }
}
