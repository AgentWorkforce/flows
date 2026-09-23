import { record, text } from './input.ts';
export const lenses = ['maintainability', 'history', 'structure'] as const;
export function reconcile(values: unknown, sha: string): { blocking: boolean; body: string } {
  if (!Array.isArray(values) || values.length !== lenses.length) throw new Error('All three lens artifacts required');
  const byLens = new Map<string, Record<string, unknown>>();
  const findings: string[] = [];
  let blocking = false;
  for (const value of values) {
    const r = record(value);
    if (!lenses.includes(r.lens as typeof lenses[number]) || byLens.has(String(r.lens)) || r.headSha !== sha || !text(r.summary) || !Array.isArray(r.findings)) throw new Error('Invalid lens artifact');
    byLens.set(String(r.lens), r);
    for (const value of r.findings) {
      const f = record(value);
      if (!text(f.file) || f.file.startsWith('/') || f.file.split('/').includes('..') || !Number.isSafeInteger(f.line) || Number(f.line) < 1
        || !['blocker', 'should-fix', 'nit'].includes(String(f.severity)) || !text(f.message) || !text(f.evidence)) throw new Error('Invalid finding');
      blocking ||= f.severity !== 'nit';
      findings.push(`- [${f.severity}] ${f.file}:${f.line}: ${f.message} — ${f.evidence} (${r.lens})`);
    }
  }
  // Retain dissent. An empty lens cannot erase another lens's finding.
  return { blocking, body: `Babysitter review at ${sha}\n\n${lenses.map(l => `${l}: ${byLens.get(l)!.summary}`).join('\n')}\n\n${[...new Set(findings)].sort().join('\n') || 'No findings.'}` };
}
