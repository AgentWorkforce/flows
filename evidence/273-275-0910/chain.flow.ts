import { flow } from '@relayflows/surface';

function shellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export default flow('flagship-llm-chain', async f => {
  const extracted = await f.llm('Return the message "hello flagship" as JSON. Do not use tools.', {
    output: {
      type: 'object', required: ['message'], additionalProperties: false,
      properties: { message: { type: 'string', const: 'hello flagship' } },
    },
  });
  if (typeof extracted !== 'object' || extracted === null
    || !('message' in extracted) || typeof extracted.message !== 'string') {
    throw new Error('Expected a verified message');
  }
  const drafted = await f.agent('draft', {
    task: `Return only JSON with one field "message" equal to ${JSON.stringify(extracted.message)}. No Markdown, tools, or file changes.`,
  });
  const value = JSON.parse(drafted.summary);
  if (value.message !== extracted.message) throw new Error('Agent did not preserve the message');
  await f.run(`printf '%s' ${shellWord(drafted.summary)} > message.json`);
  f.done('success');
});
