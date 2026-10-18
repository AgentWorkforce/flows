// FB set (eligibility forced) + secrets.
import { SURF, flowSrc, ADAPTER, NAT, G3, P_BIND, TAIL5 } from './s.mjs';
const F = [['forced', 'forced']];
const LLM_OUT = `const output = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] };`;
const refused = (forbid) => r => r.fresh === true && r.code !== 0 && ![...forbid].some(c => r.effects.includes(c));
const S = [
  { name: 'FB1', sides: F, adapter: true, extraArgs: ['--local-agent'], okIf: r => refused('LR')(r) && !r.calls,
    extraCheck: root => { try { return { calls: require('fs').readFileSync(root + '/calls', 'utf8').length }; } catch { return { calls: 0 }; } },
    files: { 'adapter.mjs': ADAPTER, 'chain.flow.ts': flowSrc('fb1', `
  ${LLM_OUT}
  const left = async () => { await f.run('printf l'); await f.llm('left', { output, model: 'test-model' }); await f.run('printf L >> effects'); };
  const right = async () => { await f.run('sleep 0.2; printf r'); await f.run('printf R >> effects'); };
  await Promise.all([left(), right()]);`) } },
  { name: 'FB2', sides: F, adapter: true, extraArgs: ['--local-agent'], okIf: refused('E'), files: { 'adapter.mjs': ADAPTER, 'chain.flow.ts': flowSrc('fb2', `
  ${LLM_OUT}
  await Promise.all([f.run('printf a'), f.run('printf b')]);
  try { await f.llm('x', { output, model: 'test-model' }); } catch (e) { void e; }
  await f.run('printf E >> effects');`) } },
  { name: 'FB3', sides: F, okIf: refused('C'), files: { 'chain.flow.ts': flowSrc('fb3', `
  await Promise.all([f.run('printf a'), f.run('printf b')]);
  await new Promise(r => setTimeout(r, 100));
  const late = async () => { await f.run('printf C >> effects'); };
  await late();`) } },
  { name: 'FB3c', sides: F, okIf: refused('CD'), files: { 'chain.flow.ts': flowSrc('fb3c', `
  const a = async () => { await new Promise(r => setTimeout(r, 100)); try { await f.run('printf C >> effects'); } catch (e) { void e; } };
  const b = async () => { await f.run('sleep 0.4; printf B'); await f.run('printf D >> effects'); };
  await Promise.all([a(), b()]);`) } },
  { name: 'FB4', sides: F, okIf: refused('B'), files: { 'chain.flow.ts': flowSrc('fb4', `
  const tree = async (d) => { if (d === 0) return; await Promise.all([tree(d - 1), tree(d - 1)]); };
  await f.run('printf A >> effects');
  await tree(12);
  try { await f.run('printf B >> effects'); } catch (e) { void e; }`) } },
  { name: 'FB6', sides: F, files: { 'chain.flow.ts': flowSrc('fb6', `
${NAT}`) } },
  { name: 'FB7', sides: F, okIf: refused('X'), files: { 'chain.flow.ts': `${SURF}\n${P_BIND}\nexport default flow('fb7', async f => {\n${G3}${TAIL5}` } },
  { name: 'FB8', sides: F, okIf: refused('q'), files: { 'chain.flow.ts': flowSrc('fb8', `
  const v = async () => { await new Promise(r => setTimeout(r, 100)); try { await f.run('printf v >> effects'); } catch (e) { void e; } };
  await Promise.all([f.run('sleep 0.6; printf 1'), f.run('sleep 0.6; printf 2'), f.run('sleep 0.6; printf 3'), f.run('sleep 0.6; printf 4'),
    f.run('sleep 0.6; printf 5'), f.run('sleep 0.6; printf 6'), f.run('sleep 0.6; printf 7'), f.run('sleep 0.6; printf 8'),
    f.run('printf q >> effects'), v()]);`) } },
];
// secrets
const SEC = `
  await Promise.all([
    f.run('printf "%s" "\${R6_TOK:-unset}" > <dir>/granted; sleep 0.2', { secrets: ['R6_TOK'] }),
    f.run('printf "%s" "\${R6_TOK:-unset}" > <dir>/ungranted; sleep 0.1'),
  ]);
  await f.run('printf "%s" "\${R6_TOK:-unset}" > <dir>/later');`;
const secCheck = root => { const fs = require('fs'); const rd = n => { try { return fs.readFileSync(root + '/' + n, 'utf8'); } catch { return 'missing'; } };
  return { sec: [rd('granted') === 'r6-secret-value' ? 'G:ok' : 'G:' + (rd('granted') === 'unset' ? 'unset' : rd('granted') === 'missing' ? 'missing' : 'other'),
    rd('ungranted') === 'unset' ? 'U:unset' : rd('ungranted') === 'missing' ? 'U:missing' : 'U:LEAK', rd('later') === 'unset' ? 'L:unset' : rd('later') === 'missing' ? 'L:missing' : 'L:LEAK'].join(' ') }; };
const HS = [['head', 'head'], ['base', 'base']];
S.push({ name: 'S1', sides: HS, env: { R6_TOK: 'r6-secret-value' }, extraCheck: secCheck, files: { 'chain.flow.ts': flowSrc('s1', SEC) } });
S.push({ name: 'S2missing', sides: HS, env: { R6_TOK: '' }, okIf: r => r.code !== 0, extraCheck: secCheck, files: { 'chain.flow.ts': flowSrc('s2', SEC.replaceAll('R6_TOK', 'R6_ABSENT')) } });
export default S;
