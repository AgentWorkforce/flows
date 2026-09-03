const IDENTIFY_ARG = '--relayflows-adapter-v1';
const IDENTIFY_TOKEN = 'relayflows-agent-cli-v1';
const EXECUTE_TOKEN = 'relayflows-agent-cli-v1-execute';

/**
 * Enter the wrapper-v1 same-process session when invoked with IDENTIFY_ARG.
 * An identify-only preflight closes stdin and exits after the first token. A
 * worker sends one JSON request; only then do we acknowledge and return it.
 */
export async function receiveWrapperRequest() {
  if (process.argv[2] !== IDENTIFY_ARG) return undefined;
  delete process.env.RELAYFLOW_MODEL;
  delete process.env.RELAYFLOW_WAKE_CONTEXT;
  process.stdout.write(`${IDENTIFY_TOKEN}\n`);
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  if (input.trim() === '') process.exit(0);
  const request = JSON.parse(input);
  if (request.protocol !== IDENTIFY_TOKEN || typeof request.instruction !== 'string') {
    process.stderr.write('invalid relayflows wrapper session request\n');
    process.exit(2);
  }
  if (request.model !== undefined) process.env.RELAYFLOW_MODEL = request.model;
  if (request.wakeContext !== undefined) {
    process.env.RELAYFLOW_WAKE_CONTEXT = JSON.stringify(request.wakeContext);
  }
  process.stdout.write(`${EXECUTE_TOKEN}\n`);
  return request;
}
