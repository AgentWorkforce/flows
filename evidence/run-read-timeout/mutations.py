"""Reproduce the four reviewed-plan mutations; always restore source bytes."""
from pathlib import Path
import hashlib
import shlex
import subprocess

ROOT = Path(__file__).resolve().parents[2]
SDK = ROOT / 'packages/sdk'
CASES = [
    ('reader', 'packages/sdk/src/journal-client.ts',
     '(reader ?? this).requestOnce(verb, params, remaining)',
     'this.requestOnce(verb, params, remaining)',
     'tests/journal-client-read-timeout.test.ts', 'serves a bounded read'),
    ('watch-cadence', 'packages/sdk/src/cli/running-step.ts',
     'const LEASE_POLL_MS = 2_000;', 'const LEASE_POLL_MS = 50;',
     'tests/running-step-watch.test.ts', 'uses pushes for completion'),
    ('heartbeat', 'packages/sdk/src/worker-lease.ts',
     """      if (error instanceof JournalRequestTimeoutError && error.verb === 'step.heartbeat') {
        throw new WorkerLeaseLostError('renewal_expired', error.message, { cause: error });
      }
""", '', 'tests/heartbeat-timeout.test.ts', 'a heartbeat timeout'),
    ('root-parking', 'packages/sdk/src/authored-root.ts',
     """    if ((error instanceof JournalRequestTimeoutError && (READ_ONLY_VERBS.has(error.verb) || error.verb === 'run.watch'))
      || (error instanceof AuthoredFlowExecutionError && error.code === 'daemon_unresponsive')) {
      const parked = new AuthoredFlowExecutionError('daemon_unresponsive',
        `${error.message}. The run remains resumable. Continue with: ${resumeCommand(dispatch.run_id, options.dataDir, options.localAgentStream !== undefined)}.`);
      parked.rootRunId = dispatch.run_id;
      throw parked;
    }
""", '', 'tests/authored-root.test.ts', 'leaves the root resumable after a read timeout'),
]

for name, source, old, new, test, pattern in CASES:
    path = ROOT / source
    original = path.read_bytes()
    assert original.count(old.encode()) == 1, (name, 'mutation must match once')
    digest = hashlib.sha256(original).hexdigest()
    command = ['npx', 'vitest', 'run', test, '-t', pattern, '--maxWorkers=1', '--minWorkers=1']
    log = ROOT / 'evidence/run-read-timeout' / f'mutation-{name}.log'
    with log.open('w') as output:
        output.write(f'Source: {source}\nOriginal SHA256: {digest}\nReplaced:\n{old}\nWith:\n{new}\n')
        try:
            path.write_bytes(original.replace(old.encode(), new.encode()))
            output.write('\nREVERTED\n$ cd packages/sdk && ' + shlex.join(command) + '\n')
            output.flush()
            failed = subprocess.run(command, cwd=SDK, stdout=output, stderr=subprocess.STDOUT)
            output.write(f'exit={failed.returncode}\n')
        finally:
            path.write_bytes(original)
        assert path.read_bytes() == original
        output.write(f'\nRESTORED SHA256: {hashlib.sha256(path.read_bytes()).hexdigest()}\n')
        output.write('$ cd packages/sdk && ' + shlex.join(command) + '\n')
        output.flush()
        passed = subprocess.run(command, cwd=SDK, stdout=output, stderr=subprocess.STDOUT)
        output.write(f'exit={passed.returncode}\n')
    print(f'{name}: reverted exit={failed.returncode}; restored exit={passed.returncode}; {log.relative_to(ROOT)}', flush=True)
    assert failed.returncode == 1 and passed.returncode == 0, name
