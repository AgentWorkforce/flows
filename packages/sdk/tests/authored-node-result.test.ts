import { beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyAuthoredNodeResult } from '../src/authored-node-runner.js';
import { parseAuthoredParentPid } from '../src/authored-runtime-capability.js';
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
function entries(command=':', id='complete-2'):Array<Record<string,unknown>> {
  return [
    {entry_type:'run.spawned',payload:{spec:{name:`example/${id}`,steps:[{id,type:'deterministic',command}]}}},
    {entry_type:'step.completed',step_id:id,payload:{completionReason:'success'}},
    {entry_type:'run.completed',payload:{completionReason:'success'}},
  ];
}
let records:Map<string,Array<Record<string,unknown>>>;
beforeEach(()=>{
  vi.clearAllMocks();
  records=new Map([['child-1',entries(':','run-1')],['child-2',entries()]]);
  mocks.runGet.mockImplementation(async (run_id:string)=>({run_id,status:'completed',steps:{
    [run_id==='child-1'?'run-1':'complete-2']:{state:'done'},
  }}));
  mocks.journalRead.mockImplementation(async(runId:string,fromSeq:number,limit=100)=>({
    entries:records.get(runId)!.map((entry,index)=>({...entry,seq:index+1}))
      .filter(entry=>entry.seq>=fromSeq).slice(0,limit),
  }));
});
describe('authored IPC result durable verification',()=>{
  it('accepts a predicate-gated flow: the `<step>.gate` child is verified but does not consume an ordinal',async()=>{
    const claimed:AuthoredFlowExecutionResult={rootRunId:'root',name:'example',completionReason:'success',journalSteps:[
      {id:'run-1',runId:'child-1',completionReason:'success'},
      {id:'run-1.gate',runId:'child-gate',completionReason:'success'},
      {id:'complete-2',runId:'child-2',completionReason:'success'},
    ]};
    records.set('child-gate',entries(`printf '%s' '{"gate":"predicate","step":"run-1","verdict":"pass"}'`,'run-1.gate'));
    mocks.runGet.mockImplementation(async (run_id:string)=>({run_id,status:'completed',steps:{
      [run_id==='child-1'?'run-1':run_id==='child-gate'?'run-1.gate':'complete-2']:{state:'done'},
    }}));
    await verifyAuthoredNodeResult(claimed,metadata,'root','socket');
    expect(mocks.runGet).toHaveBeenCalledTimes(3);
    expect(mocks.journalRead).toHaveBeenCalledWith('child-gate',1,100);
  });
  it.each([
    ['an orphan gate whose parent was not claimed', [{id:'run-9.gate',runId:'child-gate',completionReason:'success'}]],
    ['a gate claimed without a success completion', [{id:'run-1.gate',runId:'child-gate',completionReason:'step_failed'}]],
    ['a gate whose child run has no durable completion', [{id:'run-1.gate',runId:'child-missing',completionReason:'success'}]],
  ] as const)('refuses %s',async(_label,gateSteps)=>{
    const base=result();
    const claimed:AuthoredFlowExecutionResult={...base,journalSteps:[base.journalSteps[0]!,...gateSteps,base.journalSteps[1]!]};
    records.set('child-gate',entries(':','run-1.gate'));
    mocks.runGet.mockImplementation(async (run_id:string)=>{
      if(run_id==='child-missing') return {run_id,status:'running',steps:{}};
      return {run_id,status:'completed',steps:{[run_id==='child-1'?'run-1':run_id==='child-gate'?'run-1.gate':'complete-2']:{state:'done'}}};
    });
    await expect(verifyAuthoredNodeResult(claimed,metadata,'root','socket')).rejects.toThrow('no matching durable completion');
  });
  it('accepts a child spec that carries its lowered named gate as a second, completed step — and refuses one where the gate did not complete',async()=>{
    const namedGated=(gateReason:string)=>[
      {entry_type:'run.spawned',payload:{spec:{name:'example/run-1',steps:[{id:'run-1',type:'deterministic',command:':'},{id:'run-1.gate',type:'deterministic',command:'node -e 1'}]}}},
      {entry_type:'step.completed',step_id:'run-1',payload:{completionReason:'success'}},
      {entry_type:'step.completed',step_id:'run-1.gate',payload:{completionReason:gateReason}},
      {entry_type:'run.completed',payload:{completionReason:'success'}},
    ];
    records.set('child-1',namedGated('success'));
    await verifyAuthoredNodeResult(result(),metadata,'root','socket');
    records.set('child-1',namedGated('verification_failed'));
    await expect(verifyAuthoredNodeResult(result(),metadata,'root','socket')).rejects.toThrow('no matching durable completion');
    records.set('child-1',[{entry_type:'run.spawned',payload:{spec:{name:'example/run-1',steps:[{id:'run-1',type:'deterministic',command:':'},{id:'other',type:'deterministic',command:':'}]}}},
      {entry_type:'step.completed',step_id:'run-1',payload:{completionReason:'success'}},{entry_type:'run.completed',payload:{completionReason:'success'}}]);
    await expect(verifyAuthoredNodeResult(result(),metadata,'root','socket')).rejects.toThrow('no matching durable completion');
  });
  it('refuses a gate id as the terminal marker, and a count that includes gates',async()=>{
    const base=result();
    await expect(verifyAuthoredNodeResult({...base,journalSteps:[base.journalSteps[0]!,{id:'complete-2.gate',runId:'x',completionReason:'success'}]},metadata,'root','socket')).rejects.toThrow('no matching durable completion');
    await expect(verifyAuthoredNodeResult({...base,journalSteps:[base.journalSteps[0]!,{id:'run-1.gate',runId:'child-gate',completionReason:'success'},{id:'complete-3',runId:'child-2',completionReason:'success'}]},metadata,'root','socket')).rejects.toThrow('no matching durable completion');
  });
  it('requires independently read completed children and exact terminal marker',async()=>{
    await verifyAuthoredNodeResult(result(),metadata,'root','socket');
    expect(mocks.runGet).toHaveBeenCalledTimes(2);expect(mocks.journalRead).toHaveBeenCalledWith('child-2',1,100);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it.each([
    ['declined', 'declined', true],
    ['declined', 'success', false],
    ['success', 'declined', false],
  ] as const)('attests claimed %s against durable %s', async (claimedReason, durableReason, accepted) => {
    const claimed = { ...result(), completionReason: claimedReason };
    records.set('child-2', entries(durableReason === 'success' ? ':' :
      `printf '%s' '{"completionReason":"declined"}'`));
    const verified = verifyAuthoredNodeResult(claimed, metadata, 'root', 'socket');
    if (accepted) await expect(verified).resolves.toBeUndefined();
    else await expect(verified).rejects.toThrow('no matching durable completion');
  });
  it('reads successful terminal evidence beyond 100-entry journal pages',async()=>{
    const original=records.get('child-1')!;
    records.set('child-1',[original[0]!,...Array.from({length:248},()=>({entry_type:'worker.stream'})),...original.slice(1)]);
    await verifyAuthoredNodeResult(result(),metadata,'root','socket');
    expect(mocks.journalRead).toHaveBeenCalledWith('child-1',101,100);
    expect(mocks.journalRead).toHaveBeenCalledWith('child-1',201,100);
    expect(mocks.journalRead).toHaveBeenCalledWith('child-1',252,100);
  });
  it('refuses a stalled or backwards journal page instead of looping',async()=>{
    mocks.journalRead.mockResolvedValue({entries:[{seq:1,entry_type:'worker.stream'}]});
    await expect(verifyAuthoredNodeResult(result(),metadata,'root','socket')).rejects.toThrow('no matching durable completion');
    expect(mocks.journalRead).toHaveBeenCalledTimes(2);
  });
  it.each(['wrong-root','missing-terminal','duplicate-child','unfinished-child','wrong-terminal-command','missing-terminal-fact','omitted-child','unrelated-child','duplicate-terminal-fact'])(
    'refuses %s even when a result frame claims success',async kind=>{
      const claimed=result();
      if(kind==='omitted-child')Object.assign(claimed,{journalSteps:[claimed.journalSteps[1]]});
      if(kind==='unrelated-child')records.set('child-1',entries(':','other-1'));
      if(kind==='duplicate-terminal-fact')records.set('child-2',[...entries(),entries()[2]!]);
      if(kind==='wrong-root')Object.assign(claimed,{rootRunId:'other'});
      if(kind==='missing-terminal')Object.assign(claimed,{journalSteps:claimed.journalSteps.slice(0,1)});
      if(kind==='duplicate-child')Object.assign(claimed,{journalSteps:[...claimed.journalSteps,claimed.journalSteps[1]]});
      if(kind==='unfinished-child')mocks.runGet.mockResolvedValue({run_id:'child-1',status:'running',steps:{'run-1':{state:'running'}}});
      if(kind==='wrong-terminal-command')records.set('child-2',entries('echo forged'));
      if(kind==='missing-terminal-fact')records.set('child-2',entries().slice(0,-1));
      await expect(verifyAuthoredNodeResult(claimed,metadata,'root','socket')).rejects.toThrow('no matching durable completion');
    });
});
describe('authored parent identity',()=>{
  it('accepts a container PID 1 parent',()=>expect(parseAuthoredParentPid('1')).toBe(1));
  it.each([undefined,'0','-1','1.5','NaN','9007199254740992'])('refuses invalid identity %s',value=>{
    expect(()=>parseAuthoredParentPid(value)).toThrow('invalid authored parent identity');
  });
});
