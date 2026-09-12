import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deflateRawSync } from 'node:zlib';
import { bindingDependencies } from './input-binding.js';
import { isNamedGate, regexFlags } from './named-gates.js';
import type { NamedDataGate, StepSpec, VerificationSpec } from './spec.js';

const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
let re2Source: string | undefined;

/** Embed the pinned engine in the command: execution does not resolve npm or SDK paths. */
function embeddedRE2(): string {
  re2Source ??= deflateRawSync(readFileSync(createRequire(import.meta.url).resolve('re2js'))).toString('base64');
  return `const re2={};new Function('exports',require('node:zlib').inflateRawSync(Buffer.from(${JSON.stringify(re2Source)},'base64')).toString())(re2);`;
}

/**
 * A gate is a nested deterministic step in the same journal/DAG. Keep the
 * producer's identity/output, and add a barrier to every dependent (including
 * implicit input edges). Internal bindings select the whole envelope so no
 * invented output-path schema is needed. Missing paths fail in the gate.
 */
export function lowerNamedGates(steps: readonly StepSpec[]): StepSpec[] {
  const used = new Set(steps.map(step => step.id));
  const barriers = new Map<string, string>();
  for (const step of steps) {
    if (!isNamedGate(step.verification)) continue;
    let id = `${step.id}.gate`;
    while (used.has(id)) id += '.gate';
    used.add(id);
    barriers.set(step.id, id);
  }
  if (barriers.size === 0) return [...steps];
  const output: StepSpec[] = [];
  for (const step of steps) {
    const dependencies = [...new Set([...(step.dependsOn ?? []), ...bindingDependencies(step.input)])];
    const dependsOn = [...new Set([...dependencies, ...dependencies.flatMap(id => barriers.get(id) ?? [])])];
    const producer = dependsOn.length ? { ...step, dependsOn } : step;
    const gate = step.verification;
    if (!isNamedGate(gate)) {
      output.push(producer);
      continue;
    }
    // The original output is still checked for a successful process/worker
    // completion. This schema permits an internal whole-output binding.
    output.push({ ...producer, verification: { type: 'json_schema', schema: true } });
    const input = {
      output: { step: step.id },
      ...(gate.type === 'references_input' ? { reference: step.input![gate.input_key]! } : {}),
    };
    output.push({
      id: barriers.get(step.id)!, type: 'deterministic',
      dependsOn: [...new Set([step.id, ...bindingDependencies(input)])], input,
      command: gateCommand(gate, step.type === 'deterministic'),
      verification: gateVerification(gate), maxIterations: step.maxIterations ?? 1,
      ...(step.requirements === undefined ? {} : { requirements: step.requirements }),
    });
  }
  return output;
}

function gateCommand(gate: NamedDataGate, deterministic: boolean): string {
  const path = gate.type === 'subprocess_gate' ? gate.from_output
    : gate.type === 'word_count_bounds' ? undefined : gate.in_output_at;
  // Only compiler-owned code is serialized. Author strings are JSON literals;
  // upstream output travels exclusively through FLOWS_INPUT, never shell text.
  const setup = `const cp=require('node:child_process');
const input=JSON.parse(process.env.FLOWS_INPUT);
let value=input.output;
const path=${JSON.stringify(path ?? null)};
if(path!==null){for(const key of path){
if(value===null||typeof value!=='object'||!Object.hasOwn(value,key)||
(typeof key==='number'?!Array.isArray(value):Array.isArray(value)))process.exit(1);
value=value[key];
}}else if(${deterministic})value=value.stdout_tail;
const text=typeof value==='string'?value:JSON.stringify(value);
if(typeof text!=='string')process.exit(1);
`;
  let body: string;
  switch (gate.type) {
    case 'references_input':
      body = `const reference=input.reference;
if(typeof reference!=='string'||reference.length===0||!text.includes(reference))process.exit(1);
process.stdout.write('references_input:pass');`;
      break;
    case 'subprocess_gate':
      body = `if(text.includes('\\0'))process.exit(1);
const result=cp.spawnSync('/bin/sh',['-c',${JSON.stringify(gate.command)}],{
env:{...process.env,INPUT:text},stdio:'inherit'});
process.exit(result.status===0?0:1);`;
      break;
    case 'word_count_bounds':
      body = `const result=cp.spawnSync('wc',['-w'],{input:text,encoding:'utf8',env:{...process.env,LC_ALL:'C'}});
if(result.status!==0)process.exit(1);
const count=result.stdout.trim();
if(!/^[0-9]+$/.test(count))process.exit(1);
process.stdout.write(BigInt(count).toString());`;
      break;
    case 'regex_match':
      body = `${embeddedRE2()}
process.exit(re2.RE2JS.compile(${JSON.stringify(gate.pattern)},${regexFlags(gate.flags ?? '')}).matcher(text).find()?0:1);`;
      break;
  }
  return `node -e ${quote(setup + body)}`;
}

function gateVerification(gate: NamedDataGate): VerificationSpec {
  if (gate.type === 'references_input') {
    // output_contains cannot carry a runtime binding. The command resolves and
    // checks the literal substring, then emits this fixed, unforgeable receipt.
    return { type: 'output_contains', value: 'references_input:pass' };
  }
  if (gate.type === 'word_count_bounds') {
    // Deterministic output is an envelope with STRING stdout, not parsed JSON.
    // A bounded decimal language enforces the same inclusive numeric range
    // with the existing json_schema primitive and retains the actual count.
    return { type: 'json_schema', schema: {
      type: 'object', required: ['stdout_tail'], properties: {
        stdout_tail: { type: 'string', pattern: decimalRange(gate.min ?? 0, gate.max ?? Number.MAX_SAFE_INTEGER) },
      },
    } };
  }
  return { type: 'exit_code' };
}

/** Compact decimal range, bounded by 16 digits rather than by range width. */
function decimalRange(min: number, max: number): string {
  const patterns: string[] = [];
  function between(low: string, high: string, prefix: string): void {
    if (low === high) { patterns.push(prefix + low); return; }
    if (/^0+$/.test(low) && /^9+$/.test(high)) {
      patterns.push(`${prefix}[0-9]{${low.length}}`); return;
    }
    const a = Number(low[0]), b = Number(high[0]);
    if (a === b) { between(low.slice(1), high.slice(1), prefix + a); return; }
    const rest = low.length - 1;
    between(low.slice(1), '9'.repeat(rest), prefix + a);
    if (a + 1 <= b - 1) patterns.push(`${prefix}[${a + 1}-${b - 1}]${rest ? `[0-9]{${rest}}` : ''}`);
    between('0'.repeat(rest), high.slice(1), prefix + b);
  }
  for (let digits = String(min).length; digits <= String(max).length; digits++) {
    const low = digits === String(min).length ? String(min) : '1' + '0'.repeat(digits - 1);
    const high = digits === String(max).length ? String(max) : '9'.repeat(digits);
    between(low, high, '');
  }
  return `^(?:${patterns.join('|')})$`;
}
