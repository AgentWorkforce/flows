#!/usr/bin/env node
import { receiveWrapperRequest } from '../../../../testdata/preflight/wrapper-session.mjs';

if (process.argv[2] === 'auth' && process.argv[3] === 'status') {
  process.exit(process.env.RELAYFLOW_MODEL === 'yaml-test-model' ? 0 : 7);
}
const request = await receiveWrapperRequest();
if (request) {
  console.log(JSON.stringify({ instruction: request.instruction, model: request.model }));
  process.exit(request.instruction === 'fail' ? 7 : 0);
}
