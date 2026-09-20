import { unscannedArtifactPrefix } from './artifact-scan-policy.js';
import { isNamedGate } from './named-gates.js';
import type { StepSpec } from './spec.js';
import type { PreflightRefusal } from './preflight.js';

/**
 * Static named-gate reachability, decided from the compiled snapshot alone.
 *
 * An `artifact_exists` gate lowers to a deterministic step that asks whether
 * the producer's journaled `output.artifacts` list contains the literal path
 * (`named-gate-lowering.ts`). The bundled agent worker builds that list by
 * walking the step's cwd under the policy in `artifact-scan-policy.ts`, which
 * records nothing under a dot-named or `node_modules` entry. A path inside one
 * of those prefixes therefore cannot pass under that worker, on any host, in
 * any environment — so it is refused here rather than after a run.
 *
 * Scoped to the bundled worker on purpose. The journal protocol lets a custom
 * worker submit any `output`, and the gate does not reject a hidden path in
 * such a list. The refusal names the policy it applies so the scope is legible
 * in the message, and applies wherever public preflight runs: `flows check`,
 * `flows run`, `flows build` and SDK submissions all share that path.
 *
 * Temporary: this describes #513. When the scan stops excluding these paths,
 * delete this module and its call site.
 */
export function namedGateReachabilityDiagnostics(step: StepSpec): PreflightRefusal[] {
  const gate = step.verification;
  if (!isNamedGate(gate) || gate.type !== 'artifact_exists') return [];
  // A malformed path is already `gate_path_invalid` from compilation; only
  // validated relative POSIX paths reach here.
  const prefix = unscannedArtifactPrefix(gate.path);
  if (prefix === undefined) return [];
  return [{
    severity: 'refusal',
    kind: 'gate_path_unreachable',
    stepId: step.id,
    message: `Step "${step.id}" gates on artifact_exists path "${gate.path}", but the bundled agent worker's `
      + `artifact scan never records anything under "${prefix}": it skips entries whose name starts with "." `
      + 'and entries named "node_modules". The path can never appear in the journaled output.artifacts this '
      + 'gate reads, so the gate cannot pass. Write the artifact to a scanned path.',
  }];
}
