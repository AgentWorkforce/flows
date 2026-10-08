export interface FoldOptions {
  /** Collapse repeated warnings only when the caller opts in. */
  fold?: boolean;
  explain?: boolean;
  /** Every step in the spec, including llm and agent steps. */
  totalSteps?: number;
}

/** Presentation only: retain the original diagnostics for machine consumers. */
export function foldUnprovableEffects<D extends {
  severity: string; kind: string; message: string; stepId?: string;
}>(diagnostics: readonly D[], options: FoldOptions = {}): readonly (D | {
  severity: 'warning'; kind: 'unprovable_effects'; message: string;
})[] {
  if (options.fold !== true || options.explain) return diagnostics;
  const warnings = diagnostics.filter(d => d.kind === 'unprovable_effects');
  const count = new Set(warnings.flatMap(d => d.stepId === undefined ? [] : [d.stepId])).size
    + warnings.filter(d => d.stepId === undefined).length;
  if (count < 2) return diagnostics;
  const denominator = options.totalSteps === undefined ? '' : ` of ${options.totalSteps}`;
  return [
    ...diagnostics.filter(d => d.kind !== 'unprovable_effects'),
    {
      severity: 'warning', kind: 'unprovable_effects',
      message: `${count}${denominator} steps have effects that cannot be proven before execution (rerun with --explain-warnings to list them).`,
    },
  ];
}
