import { flow } from '@relayflows/surface';

export default flow('prospect-demo', async (f) => {
  const message = await f.llm`Write one short, friendly Slack message introducing
    Relayflows: a flow can generate a message with an LLM and post it to Slack.
    Return only the message text. Do not use tools or mention anyone.`;

  await f.slack.post('#test', message);
  f.done('success');
  // `flows run` prints the observer URL after the run summary when configured.
});
