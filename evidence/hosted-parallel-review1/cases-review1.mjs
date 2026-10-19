// Keep the reviewer's s676.mjs source bytes unchanged; only update expected
// outcomes for the fixes requested after that review.
import scenarios from './s676.mjs';

export default scenarios.map(scenario => {
  switch (scenario.name) {
    case 'SUB1':
      return { ...scenario, okIf: result => result.start === 'sah'
        ? result.mode === 'parallel' && result.code !== 0 && result.effects === ''
        : result.mode === 'serial' && result.code === 0 && [...result.effects].sort().join('') === 'XZpq' };
    case 'FG_edges':
      return { ...scenario, okIf: result => result.start === 'sah'
        ? result.mode === 'parallel' && result.code !== 0 && [...result.effects].sort().join('') === 'XZabc'
        : result.mode === 'serial' && result.code === 0 && [...result.effects].sort().join('') === 'XZabc' };
    case 'RB_NATW':
    case 'RB_N2':
      return { ...scenario, okIf: result => result.mode === 'parallel'
        && result.code1 !== 0 && result.effectsMid === result.effects0
        && result.code === 0 && scenario.okIf(result) };
    default:
      if (scenario.name.startsWith('TS')) return { ...scenario, okIf: result =>
        result.mode === (result.start === 'sa52' ? 'serial' : 'parallel')
          && result.code === 0 && scenario.expect(result) };
      return scenario;
  }
});
