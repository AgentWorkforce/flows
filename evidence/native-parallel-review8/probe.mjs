// Probe head's certifier on candidate entry modules (no daemon).
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
  hygiene_branch: body(`  const __certifyParallelBranch = async () => { await f.run('P'); };
  const b = async () => { await f.run('B'); };
  await Promise.all([__certifyParallelBranch(), b()]);
  await f.run('X');`),
  hygiene_value: body(`  const __certifyParallelBranch = await f.run('V');
  const a = async () => { await f.run('A'); };
  const b = async () => { await f.run('B'); };
  await Promise.all([a(), b()]);
  await f.run('X');`),
  paren_member: body(`  const a = async () => { await f.run('A'); await f.run('a'); };
  const b = async () => { await f.run('B'); await f.run('b'); };
  await Promise.all([(a()), (b())]);
  await f.run('X');`),
  paren_iife: body(`  const b = async () => { await f.run('B'); };
  await Promise.all([((async () => { await f.run('A'); })()), b()]);
  await f.run('X');`),
  twice: body(`  const a = async () => { await f.run('A'); await f.run('a'); };
  await Promise.all([a(), a()]);
  await f.run('X');`),
  ret_values: body(`  const a = async () => { return await f.run('A'); };
  const b = async () => { return await f.run('B'); };
  const r = await Promise.all([a(), b()]);
  await f.run('printf ' + r[0] + r[1]);`),
  mid_return: body(`  const a = async () => { await f.run('A'); return await f.run('A1'); await f.run('A2'); };
  const b = async () => { await f.run('B'); };
  await Promise.all([a(), b()]);
  await f.run('X');`),
  expr_branch: body(`  const a = async () => await f.run('A');
  const b = async () => await Promise.all([f.run('B1'), f.run('B2')]);
  await Promise.all([a(), b()]);
  await f.run('X');`),
  sync_throw: body(`  const x = await f.run('W');
  const a = async () => { await f.run('printf ' + x.y.z); };
  const b = async () => { await f.run('B'); };
  await Promise.all([a(), b()]);
  await f.run('X');`),
  type_import: `import type { flow } from '@relayflows/surface';\nexport default flow('p', async f => {\n  const a = async () => { await f.run('A'); };\n  const b = async () => { await f.run('B'); };\n  await Promise.all([a(), b()]);\n});\n`,
  inline_type_import: `import { type flow } from '@relayflows/surface';\nexport default flow('p', async f => {\n  const a = async () => { await f.run('A'); };\n  const b = async () => { await f.run('B'); };\n  await Promise.all([a(), b()]);\n});\n`,
  unicode_escape: body(`  const \\u0061 = async () => { await f.\\u0072un('A'); };
  const b = async () => { await f.run('B'); };
  await Pr\\u006fmise.all([\\u0061(), b()]);
  await f.run('X');`),
  optional_chain: body(`  const a = async () => { await f?.run('A'); };
  const b = async () => { await f.run?.('B'); };
  await Promise?.all([a(), b()]);
  await f.run('X');`),
  done_last: body(`  const a = async () => { await f.run('A'); };
  const b = async () => { await f.run('B'); };
  await Promise.all([a(), b()]);
  f.done('success');`),
  getter_obj: body(`  const a = async () => { await f.run('A', { get timeout() { return '5m'; } }); };
  const b = async () => { await f.run('B'); };
  await Promise.all([a(), b()]);`),
  labelled: body(`  const a = async () => { l: { await f.run('A'); } };
  const b = async () => { await f.run('B'); };
  await Promise.all([a(), b()]);`),
  arguments_nested: body(`  const a = async () => { await f.run('A' + arguments.length); };
  const b = async () => { await f.run('B'); };
  await Promise.all([a(), b()]);`),
  loop_literal: body(`  const a = async () => { await f.run('A'); };
  await Promise.all([1, 2].map(() => a()));`),
  value_member: body(`  const x = await f.run('W');
  const a = async () => { await f.run('A' + x.length); };
  const b = async () => { await f.run('B' + x[0]); };
  await Promise.all([a(), b()]);
  await f.run(x.length > 0 ? 'X' : 'Y');`),
  record_branch: body(`  const a = async () => { const r = await f.run('exit 3', { onNonZero: 'record' }); await f.run('printf ' + r.exitCode); };
  const b = async () => { await f.run('B'); };
  await Promise.all([a(), b()]);`),
  shebang: `#!/usr/bin/env node\n${body(`  const a = async () => { await f.run('A'); };
  const b = async () => { await f.run('B'); };
  await Promise.all([a(), b()]);`)}`,
  comment_before_import: `// header\n/* block */\n${body(`  const a = async () => { await f.run('A'); };
  const b = async () => { await f.run('B'); };
  await Promise.all([a(), b()]);`)}`,
  twelve: body(`  ${Array.from({ length: 12 }, (_, i) => `const b${i} = async () => { await f.run('S${i}'); await f.run('D${i}'); };`).join('\n  ')}
  await Promise.all([${Array.from({ length: 12 }, (_, i) => `b${i}()`).join(', ')}]);
  await f.run('X');`),
  optional_call_member: body(`  const a = async () => { await f.run('A'); };
  const b = async () => { await f.run('B'); };
  await Promise.all([a?.(), b?.()]);
  await f.run('X');`),
  comment_iife: body(`  const b = async () => { await f.run('B'); };
  await Promise.all([(/* c */ async () => { await f.run('A'); })(), b()]);
  await f.run('X');`),
  multi_decl: body(`  const a = async () => { await f.run('A'); }, b = async () => { await f.run('B'); };
  await Promise.all([a(), b()]);
  await f.run('X');`),
  paren_group: body(`  const a = async () => { await f.run('A'); };
  const b = async () => { await f.run('B'); };
  await (Promise.all([a(), b()]));
  await f.run('X');`),
};
const dir = '/w/probe';
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
