import type { CompiledFlowSpec } from './compile.js';
import type { PermissionsSpec } from './spec.js';
import type { PreflightWarning } from './preflight.js';

/** Declared fields, reported in this order so two runs read identically. */
const PERMISSION_FIELDS = ['fileGlobs', 'networkAllowlist', 'accessPreset'] as const;

/**
 * An agent step's `permissions` block is accepted by gate 1, lowered to
 * `file_globs` / `network_allowlist` / `access_preset`, carried in the kernel
 * step spec and journalled with it. Nothing reads it to gate a file or network
 * access: enforcement is gate 8 (#442). A spec that declares it therefore
 * looks sandboxed and is not, and until this warning existed nothing said so
 * at authoring time.
 *
 * Every defined declaration warns, including `{}` and empty arrays. SURFACE.md
 * accepts those without inferring defaults, and an empty block is exactly as
 * likely to read to an author as "a default sandbox applies". Omitting
 * `permissions` stays silent — there is no belief to correct.
 *
 * Warning-only: `ok` is unaffected, the declaration stays legal, and no value
 * is echoed back (a glob or host is often the least interesting part of the
 * declaration and can be long). The message names which fields were declared
 * so the author can find them, and nothing more.
 */
export function permissionsDiagnostics(flow: CompiledFlowSpec): PreflightWarning[] {
  const warnings: PreflightWarning[] = [];
  for (const step of flow.steps) {
    if (step.type !== 'agent' || step.permissions === undefined) continue;
    warnings.push({
      severity: 'warning',
      kind: 'permissions_unenforced',
      stepId: step.id,
      message: permissionsMessage(step.id, step.permissions),
    });
  }
  return warnings;
}

function permissionsMessage(stepId: string, permissions: PermissionsSpec): string {
  const declared = PERMISSION_FIELDS.filter((field) => permissions[field] !== undefined);
  const fields = declared.length === 0 ? '' : ` (${declared.join(', ')})`;
  // `readonly` is the one value whose entire meaning is a guarantee, so it is
  // the one value worth naming: an author reading "cannot write" needs to be
  // told, in the same breath, that today nothing stops a write.
  const preset = permissions.accessPreset === 'readonly'
    ? " accessPreset: 'readonly' does not prevent writes."
    : '';
  return `Step "${stepId}" declares permissions${fields}. `
    + 'This declaration is validated and recorded with the step spec; it is not '
    + 'currently enforced (gate 8 / #442). These permissions do not restrict file '
    + `or network access.${preset}`;
}
