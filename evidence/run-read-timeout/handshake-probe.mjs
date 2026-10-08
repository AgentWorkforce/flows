import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
const root='/home/daytona/.relayflow-v2-supervisor/durable/repository';
const {JournalClient}=await import(root+'/packages/sdk/dist/journal-client.js');
const {AgentWorker}=await import(root+'/packages/sdk/dist/worker.js');
const {socketPathFor}=await import(root+'/packages/sdk/dist/daemon-connection.js');
const data=mkdtempSync(join(tmpdir(),'rf-read-probe-'));
const daemon=spawn('/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd',['--data-dir',data,'serve'],{stdio:'ignore'});
let client,worker;
try {
 for(let i=0;i<100;i++) {
  client=new JournalClient(socketPathFor(data));
  try {await client.connect();await client.hello('probe');break;} catch {client.close();await new Promise(r=>setTimeout(r,20));}
 }
 worker=new AgentWorker(client,{workerId:'probe',pins:{workspace:[{surface:'repo',revision_id:'rev-a'}],streams:[]}});
 await worker.attach();
 const spec=JSON.parse(readFileSync(root+'/testdata/hn-monitor.spec.canonical.json','utf8'));
 for(const step of spec.steps) if(step.id==='analyze-story')step.cli=root+'/testdata/preflight/analyze-story-stub-cli';
 const outcome=await client.eventSubmit(spec,{type:'hn.story_posted',payload:{id:42000042,type:'story'}});
 for(let i=0;i<100;i++){if((await client.runGet(outcome.run.run_id)).steps['analyze-story'].state==='done')break;await new Promise(r=>setTimeout(r,50));}
 const {entries}=await client.journalRead(outcome.run.run_id,1,1000);
 console.log(JSON.stringify(entries.filter(e=>e.entry_type==='step.completed'),null,2));
}finally{await worker?.close();client?.close();daemon.kill('SIGTERM');await new Promise(r=>daemon.once('exit',r));rmSync(data,{recursive:true,force:true});}
