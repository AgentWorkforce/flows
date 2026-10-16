import { SURF, NAT, TAIL5, W2 } from './s.mjs';
const PATCH = `const I = Function('return this')()['Pro' + 'mise'];
const resolve = I.resolve;
let gate;
I.resolve = function (x) {
  if (this !== I || !(x instanceof I) || !/at (Promise|Function)\\.all /.test(new Error().stack)) return resolve.call(this, x);
  if (gate === undefined) {
    let open; const g = new I(r => { open = r; }); g.open = open; gate = g;
    queueMicrotask(() => { gate = undefined; });
  }
  const g = gate;
  x.then(v => g.open(v), () => {});
  return g;
};
`;
export default [
  { name: 'R5n', sides: [['head', 'head'], ['base', 'base']], files: {
    'chain.flow.ts': `${SURF}\nimport './lib/p.mjs';\nexport default flow('r5n', async f => {\n${W2}${NAT}${TAIL5}`,
    'lib/p.mjs': PATCH } },
];
