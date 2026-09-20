// The read side of `onNonZero: 'record'`. A `steps_green` gate names earlier
// deterministic steps and asserts every one of them recorded exit code zero.
// The verdict comes from the journal — the recorded outcome each step already
// produced — so asserting it costs nothing and cannot disagree with what ran.

import { bindingDependencies } from './input-binding.js';
import type { StepSpec, StepsGreenGate, VerificationSpec } from './spec.js';

export const STEPS_GREEN_KEYS = ['type', 'ids'] as const;

export function isStepsGreenGate(gate: VerificationSpec | undefined): gate is StepsGreenGate {
  return gate?.type === 'steps_green';
}

/** Shape errors for one gate, without reference to the rest of the flow. */
export function stepsGreenErrors(gate: Record<string, unknown>, at: string, stepType: string): string[] {
  const errors: string[] = [];
  if (stepType !== 'deterministic') {
    errors.push(`${at}: gate_host_unsupported: steps_green is supported only on deterministic steps`);
  }
  const ids = gate['ids'];
  if (!Array.isArray(ids) || ids.length === 0
    || !ids.every(id => typeof id === 'string' && id.trim().length > 0)) {
    errors.push(`${at}.ids: gate_ids_invalid: expected a non-empty array of step ids`);
    return errors;
  }
  if (new Set(ids).size !== ids.length) {
    errors.push(`${at}.ids: gate_ids_invalid: step ids must be unique`);
  }
  return errors;
}

/**
 * Flow-level errors: the ids must resolve to earlier deterministic steps whose
 * recorded outcome this gate can actually read. Refusing here is the whole
 * point — a gate that silently reads nothing is the `|| true` failure mode
 * this feature replaces.
 */
export function stepsGreenReferenceErrors(steps: readonly unknown[]): string[] {
  const errors: string[] = [];
  const sources = new Map(steps.flatMap((step, index) =>
    isObject(step) && typeof step['id'] === 'string' ? [[step['id'], { step, index }] as const] : []));
  for (const [index, step] of steps.entries()) {
    if (!isObject(step)) continue;
    const gate = step['verification'];
    if (!isObject(gate) || gate['type'] !== 'steps_green') continue;
    const ids = gate['ids'];
    if (!Array.isArray(ids)) continue;
    const at = `spec.steps[${index}].verification.ids`;
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      const source = sources.get(id);
      if (source === undefined) {
        errors.push(`${at}: gate_source_unsupported: unknown step "${id}"`);
        continue;
      }
      if (source.index >= index) {
        errors.push(`${at}: gate_source_unsupported: source "${id}" must precede this step; forward and self references are not supported`);
        continue;
      }
      if (source.step['type'] !== 'deterministic') {
        errors.push(`${at}: gate_source_unsupported: source "${id}" is a ${String(source.step['type'])} step and records no exit code`);
        continue;
      }
      // The gate binds the source's whole output envelope, which requires a
      // declared output schema. Every source shape is reachable except this
      // one: `output_contains` is the single gate the compiler cannot widen
      // without dropping the author's own check.
      const sourceGate = source.step['verification'];
      if (isObject(sourceGate) && sourceGate['type'] === 'output_contains') {
        errors.push(`${at}: gate_source_unsupported: source "${id}" declares an output_contains gate, which cannot also carry the output schema this gate reads`);
      }
    }
  }
  return errors;
}

/**
 * Lower every `steps_green` gate into a generated deterministic gate step.
 *
 * The host keeps its own command and its own exit policy; the gate is a
 * separate step, always fatal, that binds each named source's journaled output
 * envelope and refuses any nonzero or malformed exit code. Dependents of the
 * host gain a barrier on the gate, so "these steps were green" is established
 * before anything downstream of the assertion runs.
 *
 * Runs BEFORE `lowerNamedGates`, which then adds each source's own named-gate
 * barrier to the generated step and rewrites named-gate hosts to the permissive
 * envelope schema this gate's bindings need.
 */
export function lowerStepsGreenGates(steps: readonly StepSpec[]): StepSpec[] {
  const used = new Set(steps.map(step => step.id));
  const barriers = new Map<string, string>();
  for (const step of steps) {
    // Deterministic hosts only, which `validateSpec` already enforces; the
    // narrowing here is what lets the rewrite below stay type-exact.
    if (step.type !== 'deterministic' || !isStepsGreenGate(step.verification)) continue;
    let id = `${step.id}.green`;
    while (used.has(id)) id += '.green';
    used.add(id);
    barriers.set(step.id, id);
  }
  if (barriers.size === 0) return [...steps];

  // Every source's envelope has to be bindable. A source that declares no
  // gate, or the implicit exit_code gate, gets the permissive whole-output
  // schema; its exit policy is untouched, so a recording source stays red.
  const bound = new Set(steps.flatMap(step =>
    isStepsGreenGate(step.verification) ? step.verification.ids : []));
  const output: StepSpec[] = [];
  for (const step of steps) {
    const dependencies = [...new Set([...(step.dependsOn ?? []), ...bindingDependencies(step.input)])];
    const dependsOn = [...new Set([...dependencies, ...dependencies.flatMap(id => barriers.get(id) ?? [])])];
    let producer: StepSpec = dependsOn.length ? { ...step, dependsOn } : step;
    if (bound.has(step.id) && producer.type === 'deterministic'
      && (producer.verification === undefined || producer.verification.type === 'exit_code')) {
      producer = { ...producer, verification: { type: 'json_schema', schema: true } };
    }
    const gate = step.verification;
    if (producer.type !== 'deterministic' || !isStepsGreenGate(gate)) {
      output.push(producer);
      continue;
    }
    // The host's own gate becomes the implicit exit_code check. Its command
    // still runs, and its own `onNonZero` still applies to its own exit. A
    // host that is itself read by a later gate keeps the bindable envelope.
    output.push({
      ...producer,
      verification: bound.has(step.id) ? { type: 'json_schema', schema: true } : { type: 'exit_code' },
    });
    const input = Object.fromEntries(gate.ids.map((id, index) => [String(index), { step: id }]));
    output.push({
      id: barriers.get(step.id)!, type: 'deterministic',
      dependsOn: [...new Set([step.id, ...gate.ids])], input,
      command: greenCommand(gate.ids),
      verification: { type: 'exit_code' }, maxIterations: step.maxIterations ?? 1,
      ...(step.requirements === undefined ? {} : { requirements: step.requirements }),
    });
  }
  return output;
}

/**
 * Compiler-owned Node command. Author-supplied ids are JSON literals and the
 * recorded envelopes travel only through FLOWS_INPUT, never through shell text.
 */
function greenCommand(ids: readonly string[]): string {
  const script = `const input=JSON.parse(process.env.FLOWS_INPUT);
const ids=${JSON.stringify(ids)};
const red=[];
for(let i=0;i<ids.length;i++){
const envelope=input[String(i)];
if(envelope===null||typeof envelope!=='object'||Array.isArray(envelope)){red.push(ids[i]+': no recorded outcome');continue;}
const code=envelope.exit_code;
if(typeof code!=='number'||!Number.isInteger(code)){red.push(ids[i]+': recorded no integer exit_code');continue;}
if(code!==0)red.push(ids[i]+': exit code '+code);
}
if(red.length>0){process.stderr.write('steps_green: '+red.join('; ')+'\\n');process.exit(1);}
process.stdout.write('steps_green:pass');`;
  return `node -e '${script.replaceAll("'", "'\\''")}'`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
