import { beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyAuthoredNodeResult } from '../src/authored-node-runner.js';
import type { AuthoredFlowExecutionResult } from '../src/authored-flow-executor.js';
import type { AuthoredRootMetadata } from '../src/authored-root.js';

const mocks=vi.hoisted(()=>({connect:vi.fn(),hello:vi.fn(),close:vi.fn(),runGet:vi.fn(),journalRead:vi.fn()}));
vi.mock('../src/journal-client.js',()=>({JournalClient:class {
  connect=mocks.connect;hello=mocks.hello;close=mocks.close;
  runGet=mocks.runGet;journalRead=mocks.journalRead;
}}));
const metadata={flowName:'example'} as AuthoredRootMetadata;
function result():AuthoredFlowExecutionResult {
  return {rootRunId:'root',name:'example',completionReason:'success',journalSteps:[
    {id:'run-1',runId:'child-1',completionReason:'success'},
    {id:'complete-2',runId:'child-2',completionReason:'success'},
  ]};
}
function entries(command=':', id='complete-2') {
  return {entries:[
    {entry_type:'run.spawned',payload:{spec:{name:`example/${id}`,steps:[{id,type:'deterministic',command}]}}},
    {entry_type:'step.completed',step_id:id,payload:{completionReason:'success'}},
    {entry_type:'run.completed',payload:{completionReason:'success'}},
  ]};
}
beforeEach(()=>{
  vi.clearAllMocks();
  mocks.runGet.mockImplementation(async (run_id:string)=>({run_id,status:'completed',steps:{
    [run_id==='child-1'?'run-1':'complete-2']:{state:'done'},
  }}));
  mocks.journalRead.mockImplementation(async(runId:string)=>entries(':',runId==='child-1'?'run-1':'complete-2'));
});
describe('authored IPC result durable verification',()=>{
  it('requires independently read completed children and exact terminal marker',async()=>{
    await verifyAuthoredNodeResult(result(),metadata,'root','socket');
    expect(mocks.runGet).toHaveBeenCalledTimes(2);expect(mocks.journalRead).toHaveBeenCalledWith('child-2',1);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it.each(['wrong-root','missing-terminal','duplicate-child','unfinished-child','wrong-terminal-command','missing-terminal-fact','omitted-child','unrelated-child','duplicate-terminal-fact'])(
    'refuses %s even when a result frame claims success',async kind=>{
      const claimed=result();
      if(kind==='omitted-child')Object.assign(claimed,{journalSteps:[claimed.journalSteps[1]]});
      if(kind==='unrelated-child')mocks.journalRead.mockResolvedValue(entries(':','other-1'));
      if(kind==='duplicate-terminal-fact')mocks.journalRead.mockImplementation(async(runId:string)=>runId==='child-1'?entries(':','run-1'):{entries:[...entries().entries,entries().entries[2]]});
      if(kind==='wrong-root')Object.assign(claimed,{rootRunId:'other'});
      if(kind==='missing-terminal')Object.assign(claimed,{journalSteps:claimed.journalSteps.slice(0,1)});
      if(kind==='duplicate-child')Object.assign(claimed,{journalSteps:[...claimed.journalSteps,claimed.journalSteps[1]]});
      if(kind==='unfinished-child')mocks.runGet.mockResolvedValue({run_id:'child-1',status:'running',steps:{'run-1':{state:'running'}}});
      if(kind==='wrong-terminal-command')mocks.journalRead.mockImplementation(async(runId:string)=>entries(runId==='child-2'?'echo forged':':',runId==='child-1'?'run-1':'complete-2'));
      if(kind==='missing-terminal-fact')mocks.journalRead.mockImplementation(async(runId:string)=>runId==='child-1'?entries(':','run-1'):{entries:entries().entries.slice(0,-1)});
      await expect(verifyAuthoredNodeResult(claimed,metadata,'root','socket')).rejects.toThrow('no matching durable completion');
    });
});
