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
  NamedAgentSpec,
  PermissionsSpec,
  RecoveryMode,
  StepType,
  TriggerSpec,
  VerificationSpec,
} from './spec.js';
import { SPEC_SCHEMA_VERSION } from './spec.js';
import { validateOutputDeclaration } from './output-schema.js';
import { modelNameError } from './model-name.js';
import { unknownKeyErrors } from './unknown-keys.js';
import { stepDependencyErrors } from './step-dependencies.js';
import {
  AGENT_DECLARATION_FIELDS,
  FLOW_FIELDS,
  STEP_COMMON_FIELDS,
  STEP_FIELDS_BY_TYPE,
} from './step-fields.js';
import { jsonSchemaError } from './json-schema.js';

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

function isCanonicalPathSurface(value: unknown): value is string {
  if (!isNonEmptyString(value) || value.trim() !== value) return false;
  let tail = value;
  if (tail.startsWith('/')) tail = tail.slice(1);
  else {
    const scheme = tail.indexOf('://');
    if (scheme >= 0) {
      if (scheme === 0 || tail.slice(0, scheme).includes('/')) return false;
      tail = tail.slice(scheme + 3);
    }
  }
  if (tail === '') return true;
  return tail.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

// Allowed keys per authoring object level. Validation is fail-closed on
// unknown keys (AGENTS.md rule 4; RFC covenant 2): a typo'd key like
// `depends_on` must be an error naming the nearest valid key, never a
// silently discarded field — silently dropping `dependsOn` loses ordering.
const BUDGET_KEYS = ['maxTokensIn', 'maxTokensOut', 'maxDollars'] as const;
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
  'staleAfterMs',
] as const;

/**
 * The kernel stores a silence budget as SQLite `INTEGER` and compares it in
 * `i64` (`TriggerSpec::effective_stale_after_ms`), refusing anything wider.
 * Mirror the bound here so an unrepresentable budget is a compile error rather
 * than an engine error at submit time — a budget the sweep cannot represent
 * fails OPEN, which is the silent death this field exists to prevent.
 *
 * The bound is `Number.MAX_SAFE_INTEGER`, NOT `i64::MAX`. Writing the i64
 * bound as a JS literal does not express it: `9_223_372_036_854_775_807`
 * rounds UP to 2^63 in a double, so `value > MAX` then ADMITTED exactly the
 * one value the kernel refuses — the SDK/kernel-agreement failure this whole
 * file exists to prevent, in miniature. Above 2^53 a JS number cannot name a
 * specific integer at all, so any larger budget could not be transmitted
 * faithfully even if the kernel would take it. 2^53 ms is ~285,000 years;
 * nothing real is lost by refusing beyond it.
 */
const MAX_STALE_AFTER_MS = Number.MAX_SAFE_INTEGER;

class Validator {
  private errors: string[] = [];
  private ids = new Set<string>();
  private agentNames = new Set<string>();

  fail(msg: string): void {
    this.errors.push(msg);
  }

  /**
   * Reject unknown keys at an authoring object level, suggesting the nearest
   * valid key. Errors speak the author's vocabulary (RFC covenant 1):
   * `unknown key "depends_on" — did you mean "dependsOn"?`.
   */
  private checkKeys(obj: Record<string, unknown>, allowed: readonly string[], at: string): void {
    for (const error of unknownKeyErrors(obj, allowed, at)) this.fail(error);
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
    this.checkKeys(s, FLOW_FIELDS, 'spec');

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

    if (s['agents'] !== undefined) this.validateAgents(s['agents']);

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
    for (const error of stepDependencyErrors(steps, this.ids)) this.fail(error);
    return this.result();
  }

  private validateAgents(value: unknown): void {
    if (!isObject(value)) {
      this.fail('spec.agents: expected a map of named { cli, model } declarations');
      return;
    }
    for (const [name, raw] of Object.entries(value)) {
      const at = `spec.agents.${name}`;
      if (!isNonEmptyString(name) || name !== name.trim()) {
        this.fail('spec.agents: agent names must be non-empty trimmed strings');
        continue;
      }
      this.agentNames.add(name);
      if (!isObject(raw)) {
        this.fail(`${at}: expected an object with cli and model`);
        continue;
      }
      this.checkKeys(raw, AGENT_DECLARATION_FIELDS, at);
      const declaration = raw as unknown as NamedAgentSpec;
      if (!isNonEmptyString(declaration.cli) || declaration.cli !== declaration.cli.trim()) {
        this.fail(`${at}.cli: expected a non-empty trimmed string`);
      }
      this.validateModel(declaration.model, at, true);
    }
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
      this.validateStaleAfterMs(candidate.staleAfterMs, `${at}.staleAfterMs`);
    }
  }

  /**
   * A silence budget must be a positive, i64-representable whole number of
   * milliseconds. Zero is refused rather than treated as "no budget": a
   * zero-length budget marks the subscription stale on the very next sweep,
   * which reads as a permanently-broken schedule and trains an operator to
   * ignore the alert.
   */
  private validateStaleAfterMs(value: unknown, at: string): void {
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      this.fail(`${at}: expected an integer number of milliseconds`);
      return;
    }
    if (value <= 0) {
      this.fail(`${at}: expected a positive number of milliseconds, got ${value}`);
      return;
    }
    if (value > MAX_STALE_AFTER_MS) {
      this.fail(
        `${at}: ${value} exceeds ${MAX_STALE_AFTER_MS}, the largest budget that survives the `
        + `SDK -> kernel boundary exactly (the sweep stores it as i64)`,
      );
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
    this.checkKeys(st, [...STEP_COMMON_FIELDS, ...STEP_FIELDS_BY_TYPE[type]], at);

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
      } else {
        const error = jsonSchemaError(gate.schema);
        if (error !== undefined) {
          this.fail(`${at}.schema: invalid JSON Schema: ${error}`);
        }
      }
    } else {
      this.fail(`${at}.type: expected exit_code | output_contains | json_schema`);
    }
  }

  private validateDeterministic(st: DeterministicStepSpec, at: string): void {
    if (!isNonEmptyString(st.command)) {
      this.fail(`${at}.command: expected a non-empty string`);
    }
    if (st.timeoutMs !== undefined && !isPosInt(st.timeoutMs)) {
      this.fail(`${at}.timeoutMs: expected a positive integer`);
    }
  }

  private validateLlm(st: LlmStepSpec, at: string): void {
    if (!isNonEmptyString(st.prompt)) {
      this.fail(`${at}.prompt: expected a non-empty string`);
    }
    this.validateModel(st.model, at);
    this.validateCli(st.cli, at);
  }

  private validateAgent(st: AgentStepSpec, at: string): void {
    if (!isNonEmptyString(st.instruction)) {
      this.fail(`${at}.instruction: expected a non-empty string`);
    }
    if (st.agent !== undefined) {
      if (!isNonEmptyString(st.agent)) {
        this.fail(`${at}.agent: expected a non-empty named agent`);
      } else if (!this.agentNames.has(st.agent)) {
        this.fail(`${at}.agent: unknown named agent "${st.agent}"`);
      }
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

  private validateModel(model: unknown, at: string, required = false): void {
    // Rejecting the empty string matters: it would reach the CLI as
    // RELAYFLOW_MODEL='', which reads as "declared, and declared as
    // nothing" — the CLI cannot tell it from a real value and would
    // pass an empty --model. Absent and empty must not look alike.
    if (model === undefined && !required) return;
    const problem = modelNameError(model);
    if (problem !== undefined) this.fail(`${at}.model: ${problem}`);
  }

  private validateSurfaces(surfaces: AgentStepSpec['surfaces'], at: string): void {
    if (!isObject(surfaces)) {
      this.fail(`${at}: expected an object`);
      return;
    }
    const s = surfaces as Record<string, unknown>;
    this.checkKeys(s, SURFACES_KEYS, at);
    if (s['workspace'] !== undefined) {
      if (!Array.isArray(s['workspace']) || !(s['workspace'] as unknown[]).every((w) => isObject(w) && isCanonicalPathSurface((w as Record<string, unknown>)['surface']))) {
        this.fail(`${at}.workspace: expected canonical {surface: string} entries without empty, . or .. path components`);
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
      if (!Array.isArray(s['external']) || !(s['external'] as unknown[]).every(isCanonicalPathSurface)) {
        this.fail(`${at}.external: expected canonical path strings without empty, . or .. components`);
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

}

/** Validate a parsed spec object. Returns `{ok, errors}`; never throws. */
export function validateSpec(spec: unknown): ValidationResult {
  return new Validator().run(spec);
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
