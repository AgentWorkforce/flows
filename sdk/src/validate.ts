// Spec validation — fail-closed (AGENTS.md rule 4). The compiler runs every
// spec through this before emitting JSON; a malformed spec is rejected with a
// concrete error, never silently coerced. Zero-agent flows are legal: there is
// no requirement that any step be `llm` or `agent`.

import type {
  AgentStepSpec,
  BudgetSpec,
  DeterministicStepSpec,
  FlowSpec,
  LlmStepSpec,
  PermissionsSpec,
  RecoveryMode,
  StepSpec,
  StepType,
  TriggerSpec,
  VerificationSpec,
} from './spec.js';
import { SPEC_SCHEMA_VERSION } from './spec.js';
import { validateOutputDeclaration } from './output-schema.js';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const STEP_TYPES: ReadonlySet<StepType> = new Set([
  'deterministic',
  'llm',
  'agent',
]);

const RECOVERY_MODES: ReadonlySet<RecoveryMode> = new Set([
  'reset',
  'inspect',
  'manual',
]);

const DECIMAL_RE = /^\d+(\.\d+)?$/;

// Allowed keys per authoring object level. Validation is fail-closed on
// unknown keys (AGENTS.md rule 4; RFC covenant 2): a typo'd key like
// `depends_on` must be an error naming the nearest valid key, never a
// silently discarded field — silently dropping `dependsOn` loses ordering.
const ROOT_KEYS = ['version', 'name', 'description', 'cli', 'triggers', 'steps', 'budget'] as const;
const BUDGET_KEYS = ['maxTokensIn', 'maxTokensOut', 'maxDollars'] as const;
const STEP_COMMON_KEYS = ['id', 'type', 'dependsOn', 'verification', 'maxIterations', 'timeoutMs'] as const;
const STEP_TYPE_KEYS: Record<StepType, readonly string[]> = {
  deterministic: ['command'],
  llm: ['prompt', 'model', 'cli', 'output'],
  agent: ['instruction', 'cli', 'model', 'surfaces', 'recoveryMode', 'permissions', 'output'],
};
const VERIFICATION_KEYS: Record<string, readonly string[]> = {
  exit_code: ['type', 'expect'],
  output_contains: ['type', 'value'],
  json_schema: ['type', 'schema'],
};
const SURFACES_KEYS = ['workspace', 'streams', 'external'] as const;
const WORKSPACE_SURFACE_KEYS = ['surface'] as const;
const STREAM_SURFACE_KEYS = ['stream'] as const;
const PERMISSIONS_KEYS = ['fileGlobs', 'networkAllowlist', 'accessPreset'] as const;
// A trigger may also declare an event subscription. Without these keys the
// compiler rejects the very fixture the kernel advertises
// (testdata/event-triggered-flow.yaml), so the feature is unauthorable through
// the supported SDK path even though the kernel accepts it.
const TRIGGER_KEYS = [
  'id',
  'executor',
  'eventType',
  'pattern',
  'dedupeKeyTemplate',
] as const;

class Validator {
  private errors: string[] = [];
  private ids = new Set<string>();

  fail(msg: string): void {
    this.errors.push(msg);
  }

  /**
   * Reject unknown keys at an authoring object level, suggesting the nearest
   * valid key. Errors speak the author's vocabulary (RFC covenant 1):
   * `unknown key "depends_on" — did you mean "dependsOn"?`.
   */
  private checkKeys(obj: Record<string, unknown>, allowed: readonly string[], at: string): void {
    for (const key of Object.keys(obj)) {
      if (allowed.includes(key)) continue;
      const suggestion = nearestKey(key, allowed);
      this.fail(
        suggestion !== null
          ? `${at}: unknown key "${key}" — did you mean "${suggestion}"?`
          : `${at}: unknown key "${key}" (expected one of ${allowed.join(' | ')})`,
      );
    }
  }

  result(): ValidationResult {
    return { ok: this.errors.length === 0, errors: this.errors };
  }

  run(spec: unknown): ValidationResult {
    if (!isObject(spec)) {
      this.fail('spec: expected an object');
      return this.result();
    }
    const s = spec as Record<string, unknown>;
    this.checkKeys(s, ROOT_KEYS, 'spec');

    if (!isNonEmptyString(s['version'])) {
      this.fail(`spec.version: expected supported version "${SPEC_SCHEMA_VERSION}"`);
    } else if (s['version'] !== SPEC_SCHEMA_VERSION) {
      this.fail(`spec.version: unsupported version "${s['version']}" (expected "${SPEC_SCHEMA_VERSION}")`);
    }

    if (s['name'] !== undefined && !isNonEmptyString(s['name'])) {
      this.fail('spec.name: expected a non-empty string');
    }

    if (s['description'] !== undefined && typeof s['description'] !== 'string') {
      this.fail('spec.description: expected a string');
    }

    if (s['cli'] !== undefined && !isNonEmptyString(s['cli'])) {
      this.fail('spec.cli: expected a non-empty string');
    }

    if (s['triggers'] !== undefined) this.validateTriggers(s['triggers']);

    if (s['budget'] !== undefined) this.validateBudget(s['budget']);

    if (!Array.isArray(s['steps']) || s['steps'].length === 0) {
      this.fail('spec.steps: expected a non-empty array');
      return this.result();
    }

    const steps = s['steps'] as unknown[];
    for (let i = 0; i < steps.length; i++) {
      this.validateStep(steps[i], i);
    }

    // Dependents must reference real step ids and form a DAG (no cycles).
    this.validateDeps(steps as StepSpec[]);
    return this.result();
  }

  private validateBudget(b: unknown): void {
    if (!isObject(b)) {
      this.fail('spec.budget: expected an object');
      return;
    }
    this.checkKeys(b, BUDGET_KEYS, 'spec.budget');
    const budget = b as BudgetSpec;
    if (
      budget.maxTokensIn !== undefined &&
      !isNonNegInt(budget.maxTokensIn)
    ) {
      this.fail('spec.budget.maxTokensIn: expected a non-negative integer');
    }
    if (
      budget.maxTokensOut !== undefined &&
      !isNonNegInt(budget.maxTokensOut)
    ) {
      this.fail('spec.budget.maxTokensOut: expected a non-negative integer');
    }
    if (budget.maxDollars !== undefined) {
      if (typeof budget.maxDollars !== 'string' || !DECIMAL_RE.test(budget.maxDollars)) {
        this.fail('spec.budget.maxDollars: expected a decimal string, e.g. "1.50"');
      }
    }
  }

  private validateTriggers(value: unknown): void {
    if (!Array.isArray(value)) {
      this.fail('spec.triggers: expected an array');
      return;
    }
    const ids = new Set<string>();
    for (const [index, trigger] of value.entries()) {
      const at = `spec.triggers[${index}]`;
      if (!isObject(trigger)) {
        this.fail(`${at}: expected an object`);
        continue;
      }
      this.checkKeys(trigger, TRIGGER_KEYS, at);
      const candidate = trigger as unknown as TriggerSpec;
      if (!isNonEmptyString(candidate.id)) {
        this.fail(`${at}.id: expected a non-empty string`);
      } else if (ids.has(candidate.id)) {
        this.fail(`${at}.id: duplicate trigger id "${candidate.id}"`);
      } else {
        ids.add(candidate.id);
      }
      if (!isNonEmptyString(candidate.executor)) {
        this.fail(`${at}.executor: expected a non-empty string`);
      }
    }
  }

  private validateStep(step: unknown, index: number): void {
    const at = `spec.steps[${index}]`;
    if (!isObject(step)) {
      this.fail(`${at}: expected an object`);
      return;
    }
    const st = step as Record<string, unknown>;

    if (!isNonEmptyString(st['id'])) {
      this.fail(`${at}.id: expected a non-empty string`);
    } else if (this.ids.has(st['id'] as string)) {
      this.fail(`${at}.id: duplicate step id "${st['id']}"`);
    } else {
      this.ids.add(st['id'] as string);
    }

    if (!isNonEmptyString(st['type']) || !STEP_TYPES.has(st['type'] as StepType)) {
      this.fail(`${at}.type: expected one of deterministic | llm | agent`);
      return;
    }
    const type = st['type'] as StepType;
    this.checkKeys(st, [...STEP_COMMON_KEYS, ...STEP_TYPE_KEYS[type]], at);

    if (st['dependsOn'] !== undefined) {
      if (!Array.isArray(st['dependsOn']) || !(st['dependsOn'] as unknown[]).every(isNonEmptyString)) {
        this.fail(`${at}.dependsOn: expected an array of step ids`);
      }
    }

    if (st['verification'] !== undefined) {
      this.validateVerification(st['verification'], `${at}.verification`);
    }

    if (st['maxIterations'] !== undefined && !isPosInt(st['maxIterations'])) {
      this.fail(`${at}.maxIterations: expected a positive integer`);
    }

    if (st['timeoutMs'] !== undefined && !isPosInt(st['timeoutMs'])) {
      this.fail(`${at}.timeoutMs: expected a positive integer`);
    }
    if (st['timeoutMs'] !== undefined && type !== 'deterministic') {
      // The v0.1.0 spec dialect carries timeout_ms on deterministic steps
      // only; llm/agent timeouts land with worker dispatch. Fail closed
      // rather than silently drop the field.
      this.fail(`${at}.timeoutMs: only deterministic steps carry a timeout in spec v0.1.0`);
    }

    if (type === 'deterministic') {
      this.validateDeterministic(st as unknown as DeterministicStepSpec, at);
    } else if (type === 'llm') {
      this.validateLlm(st as unknown as LlmStepSpec, at);
      for (const error of validateOutputDeclaration(st, at)) this.fail(error);
    } else {
      this.validateAgent(st as unknown as AgentStepSpec, at);
      for (const error of validateOutputDeclaration(st, at)) this.fail(error);
    }
  }

  private validateVerification(v: unknown, at: string): void {
    if (!isObject(v)) {
      this.fail(`${at}: expected an object`);
      return;
    }
    const gate = v as unknown as VerificationSpec & { expect?: unknown };
    const gateKeys = typeof gate.type === 'string' ? VERIFICATION_KEYS[gate.type] : undefined;
    if (gateKeys !== undefined) {
      this.checkKeys(v, gateKeys, at);
    }
    if (gate.type === 'exit_code') {
      // v0 judges exit_code == 0 exactly (kernel DESIGN.md §4). Fail closed
      // rather than compile a spec whose gate the kernel cannot enforce.
      if (gate.expect !== undefined && gate.expect !== 0) {
        this.fail(`${at}.expect: v0 exit_code gate judges exit_code == 0; a custom expect is not supported`);
      }
    } else if (gate.type === 'output_contains') {
      if (typeof gate.value !== 'string' || gate.value.length === 0) {
        this.fail(`${at}.value: expected a non-empty string`);
      }
    } else if (gate.type === 'json_schema') {
      if (!isObject(gate.schema)) {
        this.fail(`${at}.schema: expected a JSON Schema object`);
      }
    } else {
      this.fail(`${at}.type: expected exit_code | output_contains | json_schema`);
    }
  }

  private validateDeterministic(st: DeterministicStepSpec, at: string): void {
    if (!isNonEmptyString(st.command)) {
      this.fail(`${at}.command: expected a non-empty string`);
    }
  }

  private validateLlm(st: LlmStepSpec, at: string): void {
    if (!isNonEmptyString(st.prompt)) {
      this.fail(`${at}.prompt: expected a non-empty string`);
    }
    if (st.model !== undefined && typeof st.model !== 'string') {
      this.fail(`${at}.model: expected a string`);
    }
    this.validateCli(st.cli, at);
  }

  private validateAgent(st: AgentStepSpec, at: string): void {
    if (!isNonEmptyString(st.instruction)) {
      this.fail(`${at}.instruction: expected a non-empty string`);
    }
    if (st.recoveryMode !== undefined && !RECOVERY_MODES.has(st.recoveryMode)) {
      this.fail(`${at}.recoveryMode: expected reset | inspect | manual`);
    }
    this.validateCli(st.cli, at);
    this.validateModel(st.model, at);
    if (st.surfaces !== undefined) this.validateSurfaces(st.surfaces, `${at}.surfaces`);
    if (st.permissions !== undefined) this.validatePermissions(st.permissions, `${at}.permissions`);
  }

  private validateCli(cli: unknown, at: string): void {
    if (cli !== undefined && !isNonEmptyString(cli)) {
      this.fail(`${at}.cli: expected a non-empty string`);
    }
  }

  private validateModel(model: unknown, at: string): void {
    // Rejecting the empty string matters: it would reach the CLI as
    // RELAYFLOW_MODEL='', which reads as "declared, and declared as
    // nothing" — the CLI cannot tell it from a real value and would
    // pass an empty --model. Absent and empty must not look alike.
    if (model !== undefined && !isNonEmptyString(model)) {
      this.fail(`${at}.model: expected a non-empty string`);
    }
  }

  private validateSurfaces(surfaces: AgentStepSpec['surfaces'], at: string): void {
    if (!isObject(surfaces)) {
      this.fail(`${at}: expected an object`);
      return;
    }
    const s = surfaces as Record<string, unknown>;
    this.checkKeys(s, SURFACES_KEYS, at);
    if (s['workspace'] !== undefined) {
      if (!Array.isArray(s['workspace']) || !(s['workspace'] as unknown[]).every((w) => isObject(w) && isNonEmptyString((w as Record<string, unknown>)['surface']))) {
        this.fail(`${at}.workspace: expected an array of {surface: string}`);
      } else {
        for (const [i, w] of (s['workspace'] as Record<string, unknown>[]).entries()) {
          this.checkKeys(w, WORKSPACE_SURFACE_KEYS, `${at}.workspace[${i}]`);
        }
      }
    }
    if (s['streams'] !== undefined) {
      if (!Array.isArray(s['streams']) || !(s['streams'] as unknown[]).every((w) => isObject(w) && isNonEmptyString((w as Record<string, unknown>)['stream']))) {
        this.fail(`${at}.streams: expected an array of {stream: string}`);
      } else {
        for (const [i, w] of (s['streams'] as Record<string, unknown>[]).entries()) {
          this.checkKeys(w, STREAM_SURFACE_KEYS, `${at}.streams[${i}]`);
        }
      }
    }
    if (s['external'] !== undefined) {
      if (!Array.isArray(s['external']) || !(s['external'] as unknown[]).every(isNonEmptyString)) {
        this.fail(`${at}.external: expected an array of path strings`);
      }
    }
  }

  private validatePermissions(p: PermissionsSpec, at: string): void {
    if (!isObject(p)) {
      this.fail(`${at}: expected an object`);
      return;
    }
    this.checkKeys(p as Record<string, unknown>, PERMISSIONS_KEYS, at);
    if (p.accessPreset !== undefined && p.accessPreset !== 'readonly' && p.accessPreset !== 'readwrite') {
      this.fail(`${at}.accessPreset: expected readonly | readwrite`);
    }
    if (p.fileGlobs !== undefined && !(Array.isArray(p.fileGlobs) && p.fileGlobs.every(isNonEmptyString))) {
      this.fail(`${at}.fileGlobs: expected an array of strings`);
    }
    if (p.networkAllowlist !== undefined && !(Array.isArray(p.networkAllowlist) && p.networkAllowlist.every(isNonEmptyString))) {
      this.fail(`${at}.networkAllowlist: expected an array of strings`);
    }
  }

  private validateDeps(steps: StepSpec[]): void {
    const known = this.ids;
    const adj = new Map<string, string[]>();
    for (const step of steps) {
      const deps = step.dependsOn ?? [];
      for (const d of deps) {
        if (!known.has(d)) {
          this.fail(`spec.steps: step "${step.id}" dependsOn unknown step "${d}"`);
        }
      }
      adj.set(step.id, deps);
    }
    // Cycle detection (DFS, WHITE/GRAY/BLACK).
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    for (const id of adj.keys()) color.set(id, WHITE);
    const stack: string[] = [];
    const dfs = (id: string): void => {
      color.set(id, GRAY);
      stack.push(id);
      const deps = adj.get(id) ?? [];
      for (const d of deps) {
        const c = color.get(d);
        if (c === GRAY) {
          this.fail(`spec.steps: dependency cycle detected at "${d}" (path: ${[...stack].join(' -> ')} -> ${d})`);
        } else if (c === WHITE) {
          dfs(d);
        }
      }
      stack.pop();
      color.set(id, BLACK);
    };
    for (const id of adj.keys()) {
      if (color.get(id) === WHITE) dfs(id);
    }
  }
}

/** Validate a parsed spec object. Returns `{ok, errors}`; never throws. */
export function validateSpec(spec: unknown): ValidationResult {
  return new Validator().run(spec);
}

// --- unknown-key suggestions ------------------------------------------------

/**
 * The nearest valid key for a typo, or null when nothing is close. A key that
 * differs only in casing/separators (`depends_on` -> `dependsOn`) always
 * matches; otherwise small edit distances catch plain misspellings.
 */
function nearestKey(key: string, allowed: readonly string[]): string | null {
  const normalize = (value: string): string => value.toLowerCase().replace(/[_-]/g, '');
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of allowed) {
    if (normalize(candidate) === normalize(key)) return candidate;
    const distance = levenshtein(key.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best !== null && bestDistance <= 3 && bestDistance < best.length ? best : null;
}

function levenshtein(a: string, b: string): number {
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(deletion, insertion, substitution);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

// --- predicates -------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}
