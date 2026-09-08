import json,pathlib,subprocess,tempfile,shlex,sys
binary=str(pathlib.Path(sys.argv[1]).resolve())
def run(args,cwd):
 print('$ '+shlex.join(args), flush=True)
 r=subprocess.run(args,cwd=cwd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
 print(r.stdout,end='');print('exit_code='+str(r.returncode),flush=True)
 if r.returncode: raise SystemExit(r.returncode)
 return r.stdout
with tempfile.TemporaryDirectory(prefix='placement-drift-') as temp:
 root=pathlib.Path(temp); tree=root/'tree';tree.mkdir();data=root/'data'
 run(['git','init','-q'],tree)
 (tree/'source.txt').write_text('original\n')
 run(['git','add','source.txt'],tree)
 commit=['git','-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-qm']
 run(commit+['original'],tree)
 spec=root/'flow.json';spec.write_text(json.dumps({'steps':[
 {'id':'first','type':'deterministic','command':'cat source.txt','requirements':{'workspace':True}},
 {'id':'second','type':'deterministic','command':'cat source.txt','depends_on':['first'],'requirements':{'workspace':True}}]}))
 outcome=json.loads(run([binary,'--data-dir',str(data),'run',str(spec),'--stop-after','1'],tree))
 (tree/'source.txt').write_text('changed-between-steps\n')
 run(['git','add','source.txt'],tree);run(commit+['changed'],tree)
 run([binary,'--data-dir',str(data),'resume',outcome['run_id']],tree)
 import sqlite3
 with sqlite3.connect(next((data/'runs').glob('*.sqlite3'))) as db:
  for entry_type,step,payload in db.execute("select entry_type,step_id,payload from entries where entry_type in ('step.attempt.started','step.completed') order by seq"):
   payload=json.loads(payload)
   print(json.dumps({'entry_type':entry_type,'step':step,'pins':payload.get('pins'),'output':payload.get('output')}))
