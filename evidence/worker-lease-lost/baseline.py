from pathlib import Path
import subprocess,os
root=Path.cwd()
files=subprocess.check_output(['git','diff','--name-only','f6ece41','HEAD','--','packages/sdk/src'],text=True).splitlines()
originals={name:(root/name).read_bytes() for name in files}
env={**os.environ,'PATH':'/home/daytona/.cargo/bin:'+os.environ['PATH'],'RELAYFLOWD_BIN':'/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd'}
def run(cmd,name):
 with (root/'evidence/worker-lease-lost'/name).open('w') as f:
  f.write('$ cd packages/sdk && '+cmd+'\n');f.flush()
  result=subprocess.run(cmd,shell=True,cwd=root/'packages/sdk',env=env,stdout=f,stderr=subprocess.STDOUT)
  f.write('\nExit code: '+str(result.returncode)+'\n')
 return result.returncode
try:
 for name in files:
  (root/name).write_bytes(subprocess.check_output(['git','show','f6ece41:'+name]))
 assert run('npm run build','baseline-build.txt')==0
 run('npx vitest run tests/live-kernel.test.ts','baseline-live-kernel.txt')
finally:
 for name,data in originals.items(): (root/name).write_bytes(data)
 assert all((root/name).read_bytes()==data for name,data in originals.items())
 assert run('npm run build','restored-build.txt')==0
