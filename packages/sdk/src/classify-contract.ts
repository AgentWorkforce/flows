import type { ClassifyOptions, ClassifyResult } from '@relayflows/surface';
import { snapshotJsonValue } from './json-value.js';

export const JEV_MODEL = 'jev-latest';
export const CLASSIFY_KIND = 'typesafe.classify';
export const CLASSIFY_BUDGET_WARNING = 'Jev classification reports no token or dollar usage. Token and dollar ceilings cannot bound its spend; timeoutMs bounds its HTTP duration.';

/** Copy in fixed field order: journal reads sort keys, admission binds bytes. */
export function classifyOptions(raw: unknown): Required<Omit<ClassifyOptions, 'fallback'>> & { fallback?: string } {
  // At most 39 nodes at depth 2; 560 KB covers even six-byte JSON escaping
  // of every character in the largest valid question, state and 32 criteria.
  const value = snapshotJsonValue(raw, 'f.classify options', {
    maxDepth: 2, maxNodes: 40, maxBytes: 560_000,
  }) as unknown as ClassifyOptions;
  const invalid = (detail: string): never => { throw new TypeError(`f.classify ${detail}`); };
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !['question', 'state', 'options', 'minConfidence', 'fallback', 'timeoutMs'].includes(k))) {
    invalid('accepts question, state, options, minConfidence, fallback, and timeoutMs.');
  }
  if (typeof value.question !== 'string' || !value.question.trim() || value.question.length > 4000) invalid('question must contain 1–4000 characters.');
  if (typeof value.state !== 'string' || value.state.length > 20_000) invalid('state must be a string of at most 20,000 characters.');
  if (!value.options || typeof value.options !== 'object' || Array.isArray(value.options)) invalid('options must map choices to criteria.');
  const entries = Object.entries(value.options).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (entries.length < 2 || entries.length > 32 || entries.some(([key, criteria]) =>
    !key.trim() || key.length > 100 || typeof criteria !== 'string' || !criteria.trim() || criteria.length > 2000)) {
    invalid('requires 2–32 named choices (1–100 characters) with criteria (1–2000 characters).');
  }
  const minConfidence = value.minConfidence === undefined ? 0.6 : value.minConfidence;
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) invalid('minConfidence must be between 0 and 1.');
  const timeoutMs = value.timeoutMs === undefined ? 8000 : value.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) invalid('timeoutMs must be an integer from 1 to 30000.');
  if (value.fallback !== undefined && (typeof value.fallback !== 'string' || !Object.hasOwn(value.options, value.fallback))) invalid('fallback must name a declared choice.');
  return {
    question: value.question, state: value.state, options: Object.fromEntries(entries), minConfidence,
    timeoutMs, ...(value.fallback === undefined ? {} : { fallback: value.fallback }),
  };
}

export function classifyPrompt(options: unknown): string {
  return JSON.stringify({ type: CLASSIFY_KIND, ...classifyOptions(options) });
}

/** Recognize the SDK's direct Jev protocol without selecting a project CLI. */
export function isClassifyStep(step: { type: string; model?: string; cli?: string; prompt?: string }, flowCli?: string): boolean {
  if (step.type !== 'llm' || step.model !== JEV_MODEL || step.cli !== undefined || flowCli !== undefined || typeof step.prompt !== 'string') return false;
  try { return JSON.parse(step.prompt)?.type === CLASSIFY_KIND; }
  catch { return false; }
}

/** Refuse a malformed or foreign successful journal value before typed branching. */
export function readClassifyResult(value: unknown, rawOptions: unknown): ClassifyResult | undefined {
  const options = classifyOptions(rawOptions);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const result = value as Record<string, unknown>;
  const { choice, confidence, completionReason, fallbackReason } = result;
  if (completionReason !== 'success' || typeof choice !== 'string' || !Object.hasOwn(options.options, choice)
    || typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return undefined;
  if (fallbackReason !== undefined) {
    if (typeof fallbackReason !== 'string' || !/^[a-z0-9_]{1,64}$/.test(fallbackReason)
      || options.fallback !== choice || confidence !== 0) return undefined;
  } else if (confidence < options.minConfidence) return undefined;
  return { choice, confidence, completionReason: 'success', ...(fallbackReason === undefined ? {} : { fallbackReason }) };
}
