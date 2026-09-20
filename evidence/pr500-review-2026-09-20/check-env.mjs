import {writeFileSync} from 'node:fs';
const names = ['FLOW_COMMUNICATION_UNRELATED_SECRET','GITHUB_TOKEN','AWS_SECRET_ACCESS_KEY','RELAY_API_KEY','RELAY_WORKSPACE_KEY','AGENT_RELAY_WORKSPACE_KEY','RELAY_BROKER_API_KEY'];
for (const name of names) if (process.env[name]) throw new Error('Unexpected inherited credential: '+name);
if (!process.env.RELAYFLOW_COMMUNICATION_TOKEN || !process.env.RELAYFLOW_COMMUNICATION_SOCKET) throw new Error('Missing session authentication');
writeFileSync('/tmp/flows-pr500-review-live/env-'+process.argv[2]+'.json', JSON.stringify({cli:process.argv[2],unrelatedCredentialsAbsent:true,sessionAuthenticationPresent:true}));
console.log('Environment isolation check passed');
