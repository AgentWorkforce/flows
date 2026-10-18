// Review-8 probe (copy of review-7 probe.mjs with new cases). Probe head's certifier on candidate entry modules (no daemon).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const sdk = '/w/head/packages/sdk/dist';
const { parallelRunEligible, parallelBodySyntaxEligible } = await import(`${sdk}/authored-parallel-eligibility.js`);
const { instrumentParallelBody } = await import(`${sdk}/authored-parallel-body.js`);
const SURF = `import { flow } from '@relayflows/surface';`;
const body = (b) => `${SURF}\nexport default flow('p', async f => {\n${b}\n});\n`;
const cases = {
  baseline_native: body(`  const a = async () => { await f.run('A'); await f.run('a'); };
  const b = async () => { await f.run('B'); await f.run('b'); };
  await Promise.all([a(), b()]);
  await f.run('X');`),
  esc_branch_name: body(`  const \\u005f_certifyParallelBranch = async () => { await f.run('P'); };
  const b = async () => { await f.run('B'); };
  await Promise.all([\\u005f_certifyParallelBranch(), b()]);
  await f.run('X');`),
  esc_value_name: body(`  const \\u005f\\u005fcertifyParallelBranch = await f.run('V');
  const a = async () => { await f.run('A'); };
  const b = async () => { await f.run('B'); };
  await Promise.all([a(), b()]);
  await f.run('X');`),
  esc_call_only: body(`  const a = async () => { await f.run('A'); };
  const b = async () => { await f.run('B'); };
  await Promise.all([a(), b()]);
  await f.run('X' + \\u005f_certifyParallelBranch);`),
  param_name: `${SURF}\nexport default flow('p', async __certifyParallelBranch => {\n  const a = async () => { await __certifyParallelBranch.run('A'); };\n  const b = async () => { await __certifyParallelBranch.run('B'); };\n  await Promise.all([a(), b()]);\n});\n`,
  destructure_name: body(`  const { __certifyParallelBranch } = await f.run('V');
  const a = async () => { await f.run('A'); };
  const b = async () => { await f.run('B'); };
  await Promise.all([a(), b()]);`),
  shorthand_name: body(`  const a = async () => { await f.run('A', { __certifyParallelBranch }); };
  const b = async () => { await f.run('B'); };
  await Promise.all([a(), b()]);`),
  property_name: body(`  const v = await f.run('V');
  const a = async () => { await f.run('A' + v.__certifyParallelBranch); };
  const b = async () => { await f.run('B'); };
  await Promise.all([a(), b()]);`),
  string_name: body(`  const a = async () => { await f.run('__certifyParallelBranch'); };
  const b = async () => { await f.run('B'); };
  await Promise.all([a(), b()]);`),
  template_name: body(`  const a = async () => { await f.run(\`printf __certifyParallelBranch\`); };
  const b = async () => { await f.run('B'); };
  await Promise.all([a(), b()]);`),
  template_value: body(`  const v = await f.run('V');
  const a = async () => { await f.run(\`printf \${v} \${v.length}\`); };
  const b = async () => { await f.run(\`B\`); };
  await Promise.all([a(), b()]);`),
  double_paren: body(`  const a = async () => { await f.run('A'); };
  const b = async () => { await f.run('B'); };
  await Promise.all([((a())), (((b())))]);
  await f.run('X');`),
  paren_callee: body(`  const a = async () => { await f.run('A'); };
  const b = async () => { await f.run('B'); };
  await Promise.all([(a)(), b()]);`),
  paren_optional: body(`  const a = async () => { await f.run('A'); };
  const b = async () => { await f.run('B'); };
  await Promise.all([(a?.()), (b())]);
  await f.run('X');`),
  comma_member: body(`  const a = async () => { await f.run('A'); };
  const b = async () => { await f.run('B'); };
  await Promise.all([(0, a()), b()]);`),
  void_member: body(`  const a = async () => { await f.run('A'); };
  const b = async () => { await f.run('B'); };
  await Promise.all([void a(), b()]);`),
  await_member: body(`  const a = async () => { await f.run('A'); };
  const b = async () => { await f.run('B'); };
  await Promise.all([await a(), b()]);`),
  not_member: body(`  const a = async () => { await f.run('A'); };
  const b = async () => { await f.run('B'); };
  await Promise.all([!a(), b()]);`),
  expr_noawait_branch: body(`  const a = async () => f.run('A');
  const b = async () => { await f.run('B'); };
  await Promise.all([a(), b()]);
  await f.run('X');`),
  return_thenable: body(`  const a = async () => { await f.run('A'); return { then(r) { r(1); } }; };
  const b = async () => { await f.run('B'); };
  await Promise.all([a(), b()]);`),
  await_thenable: body(`  const a = async () => { await f.run('A'); await { then(r) { r(1); } }; await f.run('a'); };
  const b = async () => { await f.run('B'); };
  await Promise.all([a(), b()]);`),
  wrapped_step_member: body(`  const b = async () => { await f.run('B'); };
  await Promise.all([{ x: f.run('A') }, b()]);`),
  run_member_paren: body(`  await Promise.all([(f.run('A')), ((f.run('B')))]);
  await f.run('X');`),
  nested_branch_call: body(`  const a = async () => { await f.run('A'); };
  const b = async () => { await Promise.all([a(), f.run('B')]); };
  await Promise.all([a(), b()]);`),
  iife_async_check: body(`  await Promise.all([(() => f.run('A'))(), (async () => { await f.run('B'); })()]);`),
  done_detail: body(`  const a = async () => { await f.run('A'); };
  const b = async () => { await f.run('B'); };
  await Promise.all([a(), b()]);
  f.done('success', { detail: 'x' });`),
  elem_proto: body(`  const v = await f.run('V');
  const a = async () => { await f.run('A' + v['constructor']); };
  const b = async () => { await f.run('B'); };
  await Promise.all([a(), b()]);`),
};
const dir = '/w/probe8';
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
fs.symlinkSync('/w/head/packages/sdk/node_modules', path.join(dir, 'node_modules'));
const { getFlowDefinition } = await import('/w/head/packages/sdk/node_modules/@relayflows/surface/dist/runtime.js');
for (const [name, src] of Object.entries(cases)) {
  const file = path.join(dir, `${name}.flow.ts`);
  fs.writeFileSync(file, src);
  let line;
  try {
    const mod = await import(pathToFileURL(file).href);
    const def = getFlowDefinition(mod.default);
    const full = parallelRunEligible(def.body, src);
    const grammar = parallelBodySyntaxEligible(def.body);
    let instr = '';
    if (grammar) { try { instr = String(instrumentParallelBody(def.body, () => {})).match(/__certifyParallelBranch\([^)]*\)/g)?.length ?? 0; } catch (e) { instr = 'throw:' + e.message; } }
    line = `${name}: certified=${full} grammar=${grammar} wrappedCalls=${instr}`;
  } catch (e) { line = `${name}: LOAD ERROR ${String(e.message).slice(0, 120)}`; }
  console.log(line);
}
