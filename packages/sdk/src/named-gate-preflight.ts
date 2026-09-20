import { unscannedArtifactPrefix } from './artifact-scan-policy.js';
import { isNamedGate } from './named-gates.js';
import type { StepSpec } from './spec.js';
import type { PreflightWarning } from './preflight.js';

/**
 * Static named-gate scan coverage, decided from the compiled snapshot alone.
 *
 * An `artifact_exists` gate lowers to a deterministic step that asks whether
 * the producer's journaled `output.artifacts` list contains the literal path
 * (`named-gate-lowering.ts`). One writer of that list is the bundled agent
 * worker's filesystem scan, which walks the step's cwd under the policy in
 * `artifact-scan-policy.ts` and records nothing under a dot-named or
 * `node_modules` entry. A path inside one of those prefixes can never come
 * from that scan, on any host, in any environment.
 *
 * A warning rather than a refusal, because the scan is not the only writer.
 * The same bundled worker promotes object-shaped JSON stdout — and a completed
 * Relay task's output — straight to the journaled `output` (`worker.ts`), so
 * an agent that reports its own `artifacts` array makes a hidden path pass;
 * the journal protocol lets a custom worker do the same. Which of those an
 * `agent` step will take is not decidable from the spec, so this reports the
 * scan's limitation and leaves the verdict to the run rather than declaring a
 * satisfiable gate impossible.
 *
 * Temporary: this describes #513. When the scan stops excluding these paths,
 * delete this module and its call site.
 */
export function namedGateScanCoverageDiagnostics(step: StepSpec): PreflightWarning[] {
  const gate = step.verification;
  if (!isNamedGate(gate) || gate.type !== 'artifact_exists') return [];
  // A malformed path is already `gate_path_invalid` from compilation; only
  // validated relative POSIX paths reach here.
  const prefix = unscannedArtifactPrefix(gate.path);
  if (prefix === undefined) return [];
  return [{
    severity: 'warning',
    kind: 'gate_path_unscanned',
    stepId: step.id,
    message: `Step "${step.id}" gates on artifact_exists path "${gate.path}", but the bundled agent worker's `
      + `artifact scan records nothing under "${prefix}": it skips entries whose name starts with "." and `
      + 'entries named "node_modules". The gate reads the journaled output.artifacts and never the disk, so '
      + 'writing the file is not enough: the step has to report the path itself — as object-shaped JSON stdout '
      + 'carrying its own "artifacts" array, as a completed Relay task output, or from a custom worker. If the '
      + 'gate is meant to rest on the scan, write the artifact to a path the scan records.',
  }];
}
