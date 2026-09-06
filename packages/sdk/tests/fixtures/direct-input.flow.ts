import { flow } from '@relayflows/surface';

interface DirectInput {
  output: string;
  value: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export default flow('direct-input-fixture', {}, async (f, input: DirectInput) => {
  await f.run(`printf %s ${shellQuote(input.value)} > ${shellQuote(input.output)}`);
  f.done('success');
});
