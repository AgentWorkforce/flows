// The rebase trap: `output` must be accepted on llm and agent and refused on
// deterministic, through validateSpec AND compileYaml (flows check is run
// separately against the fixtures this writes).
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { validateSpec } = await import(`${REPO}/sdk/dist/validate.js`);
const { compileYaml, toKernelSpec } = await import(`${REPO}/sdk/dist/compile.js`);

// Documented shape (docs/SURFACE.md): the JSON Schema sits directly under `output`.
const OUTPUT = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] };
// PRIMARY: only compileYaml + toKernelSpec distinguishes "the key was accepted"
// from "the key became a gate". validateSpec and `flows check` both report a
// healthy gate when the LOWERING has been reverted but the allowlist is intact,
// so they are supporting witnesses, not the assertion.
console.log('--- PRIMARY: compileYaml + toKernelSpec (does `output` BECOME a gate?)');
const lowered = (yaml) => toKernelSpec(compileYaml(yaml))
  .steps[0].verification;
console.log('--- PATH 1 (supporting): validateSpec');
for (const [label, step, want] of [
  ['llm           ', { id: 's', type: 'llm', prompt: 'p', cli: 'claude', output: OUTPUT }, 'ACCEPT'],
  ['agent         ', { id: 's', type: 'agent', instruction: 'i', cli: 'claude', output: OUTPUT }, 'ACCEPT'],
  ['deterministic ', { id: 's', type: 'deterministic', command: 'true', output: OUTPUT }, 'REFUSE'],
]) {
  const r = validateSpec({ version: '0.1.0', name: 'output-proof', steps: [step] });
  const got = r.ok ? 'ACCEPT' : 'REFUSE';
  console.log(`  ${label} -> ${got}  ${got === want ? 'OK  ' : 'WRONG'}  ${r.ok ? '' : r.errors.join(' | ')}`);
}

const head = 'version: "0.1.0"\nname: output-proof\nsteps:\n';
const schema = '    output:\n      type: object\n      properties:\n        verdict:\n          type: string\n      required: [verdict]\n';
const bodies = {
  llm: '  - id: s\n    type: llm\n    prompt: p\n    cli: claude\n' + schema,
  agent: '  - id: s\n    type: agent\n    instruction: i\n    cli: claude\n' + schema,
  deterministic: '  - id: s\n    type: deterministic\n    command: "true"\n' + schema,
};
const want = { llm: 'ACCEPT', agent: 'ACCEPT', deterministic: 'REFUSE' };
console.log('--- PATH 2: compileYaml');
const outDir = process.argv[2];
if (outDir) mkdirSync(outDir, { recursive: true });
for (const [name, body] of Object.entries(bodies)) {
  const yaml = head + body;
  if (outDir) writeFileSync(`${outDir}/${name}.flow.yaml`, yaml);
  let got, detail = '';
  try { compileYaml(yaml); got = 'ACCEPT'; }
  catch (e) { got = 'REFUSE'; detail = String(e.message).split('\n').slice(0, 2).join(' / '); }
  console.log(`  ${name.padEnd(14)} -> ${got}  ${got === want[name] ? 'OK  ' : 'WRONG'}  ${detail}`);
}

console.log('--- PRIMARY: kernel verification emitted for each verb');
const wantGate = JSON.stringify({ json_schema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] } });
for (const [name, body] of Object.entries(bodies)) {
  const yaml = head + body;
  let line;
  try {
    const v = lowered(yaml);
    const emitted = JSON.stringify(v);
    const isGate = emitted !== undefined && emitted.includes('json_schema');
    const matches = emitted === wantGate;
    line = `emitted verification = ${emitted}` +
      `  -> ${isGate ? (matches ? 'IS THE DECLARED json_schema GATE  OK' : 'json_schema BUT NOT THE DECLARED SCHEMA  WRONG') : 'NOT A json_schema GATE  WRONG'}`;
  } catch (e) {
    line = `REFUSED at compile: ${String(e.message).split('\n')[0]}` +
      (name === 'deterministic' ? '  -> OK (deterministic must not accept output)' : '  -> WRONG');
  }
  console.log(`  ${name.padEnd(14)} ${line}`);
}
if (outDir) console.log(`--- PATH 3 (supporting) fixtures written to ${outDir} (run: node sdk/dist/cli.js check <fixture>)`);
