import { flow } from '@relayflows/surface';

export default flow('prospect-demo', async (f) => {
  const result = await f.llm(
    `Write one short, friendly Slack message introducing
    Relayflows: a flow can generate a message with an LLM and post it to Slack.
    Return only JSON with one string field named message. Do not use tools or mention anyone.`,
    { cli: 'claude', model: 'claude-sonnet-5', output: {
      type: 'object', required: ['message'], additionalProperties: false,
      properties: { message: { type: 'string' } },
    } },
  ) as { message: string };

  await f.slack.post('#test', result.message);
  f.done('success');
  // `flows run` prints the observer URL after the run summary when configured.
});
