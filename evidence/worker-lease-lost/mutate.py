from pathlib import Path
import subprocess, hashlib, os
root=Path.cwd()
sdk=root/'packages/sdk'
evidence=root/'evidence/worker-lease-lost'
env={**os.environ, 'PATH':'/home/daytona/.cargo/bin:'+os.environ['PATH']}
def run(name,command):
    result=subprocess.run(command,cwd=sdk,env=env,shell=True,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    (evidence/(name+'.txt')).write_text('$ cd packages/sdk && '+command+'\n'+result.stdout+'\nExit code: '+str(result.returncode)+'\n')
    return result.returncode
def mutation(name,path,old,new,command):
    p=root/path
    original=p.read_bytes()
    assert old.encode() in original
    try:
        p.write_bytes(original.replace(old.encode(),new.encode(),1))
        failed=run(name+'-mutant',command)
    finally:
        p.write_bytes(original)
    assert p.read_bytes()==original
    passed=run(name+'-restored',command)
    with (evidence/'mutations.txt').open('a') as f:
        f.write(f'{name}\nFile: {path}\nReplace: {old!r}\nWith: {new!r}\nRestored SHA256: {hashlib.sha256(original).hexdigest()}\nMutant exit: {failed}; restored exit: {passed}\n\n')
    assert failed != 0 and passed == 0,(name,failed,passed)
(evidence/'mutations.txt').write_text('')
mutation('filter','packages/sdk/src/worker-lease.ts',
    'if (!isLeaseLost(error))', 'if (true)',
    'npx vitest run tests/worker-lease-lost.test.ts')
mutation('terminal','packages/sdk/src/worker-lease.ts',
    "error.code === 'run_terminal'", "error.code === 'never_drop_terminal'",
    "npx vitest run tests/worker-lease-lost.test.ts -t run_terminal")
mutation('fatal','packages/sdk/src/worker-lease.ts',
    'if (!isLeaseLost(error)) { fatal(error); return; }',
    'if (!isLeaseLost(error)) { return; }',
    "npx vitest run tests/worker-lease-lost.test.ts -t 'non-lease worker error'")
mutation('live','packages/sdk/src/worker-lease.ts',
    'if (!isLeaseLost(error))', 'if (true)',
    'npx vitest run tests/worker-lease-lost-live.test.ts')
mutation('sweep','packages/sdk/src/cli/run.ts',
    'leaseDeadlineMs + LEASE_SWEEP_GRACE_MS - Date.now()', 'leaseDeadlineMs - Date.now()',
    'npx vitest run tests/worker-lease-sweep.test.ts')
mutation('direct','packages/sdk/src/cli/direct-run.ts',
    "localLlm.on('error', onWorkerFailure('local-llm', error => { llmFailure = error; client.close(); }));",
    "localLlm.on('error', error => { llmFailure = error; client.close(); });",
    'npx vitest run tests/direct-run-worker-lease.test.ts')
mutation('resume','packages/sdk/src/cli/run.ts',
    """        authoredLlm.on('error', onWorkerFailure('resume-llm', error => {
          llmFailure = error;
          client.close();
        }));
""", '',
    'npx vitest run tests/resume-worker-lease.test.ts')
