import { flow } from '@relayflows/surface';

interface ControlInput {
  output: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export default flow('direct-output-control', async (f, input: ControlInput) => {
  const append = async (value: string): Promise<void> => {
    await f.run(`printf %s ${shellQuote(value)} >> ${shellQuote(input.output)}`);
  };
  const value = await f.run('printf value');
  const empty = await f.run('printf %s ""');

  if (value) await append('truthy,');
  if (!empty) await append('negation,');
  if (value == 'value') await append('loose,');
  if (value === 'value') await append('strict,');
  await append(value ? 'ternary,' : 'wrong,');
  value && await append('and,');
  empty || await append('or');
  f.done('success');
});
