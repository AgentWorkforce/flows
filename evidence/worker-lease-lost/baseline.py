from pathlib import Path
import subprocess,os
root=Path.cwd()
# The rebased parent, not a hard-coded commit: BASE=<rev> overrides.
base=os.environ.get('BASE') or subprocess.check_output(['git','merge-base','HEAD','origin/main'],text=True).strip()
files=subprocess.check_output(['git','diff','--name-only',base,'HEAD','--','packages/sdk/src'],text=True).splitlines()
originals={name:(root/name).read_bytes() for name in files}
env={**os.environ,'PATH':os.path.expanduser('~/.cargo/bin')+':'+os.environ['PATH']}  # RELAYFLOWD_BIN, if needed, comes from the caller
def run(cmd,name):
 with (root/'evidence/worker-lease-lost'/name).open('w') as f:
  f.write('# base '+base+'\n$ cd packages/sdk && '+cmd+'\n');f.flush()
  result=subprocess.run(cmd,shell=True,cwd=root/'packages/sdk',env=env,stdout=f,stderr=subprocess.STDOUT)
  f.write('\nExit code: '+str(result.returncode)+'\n')
 return result.returncode
try:
 for name in files:
  (root/name).write_bytes(subprocess.check_output(['git','show',base+':'+name]))
 assert run('npm run build','baseline-build.txt')==0
 run('npx vitest run tests/live-kernel.test.ts','baseline-live-kernel.txt')
finally:
 for name,data in originals.items(): (root/name).write_bytes(data)
 assert all((root/name).read_bytes()==data for name,data in originals.items())
 assert run('npm run build','restored-build.txt')==0
