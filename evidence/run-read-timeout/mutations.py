"""Reproduce the reviewed mutations against the current source; always restore source bytes."""
from pathlib import Path
import hashlib
import shlex
import subprocess

ROOT = Path(__file__).resolve().parents[2]
SDK = ROOT / 'packages/sdk'
CASES = [
    ('reader', 'packages/sdk/src/journal-budgeted-reads.ts',
     'return await reader.requestOnce(verb, params, remaining, attemptSignal);',
     'return await this.primary.requestOnce(verb, params, remaining, attemptSignal);',
     'tests/journal-client-read-timeout.test.ts', 'serves a bounded read'),
    ('reader-reconnect', 'packages/sdk/src/journal-budgeted-reads.ts',
     """        this.drop(reader);
""", '', 'tests/journal-client-read-timeout.test.ts', 'reconnects the reader after it disconnects'),
    ('reader-setup-retry', 'packages/sdk/src/journal-budgeted-reads.ts',
     """          if (this.reader === reader) {
            this.reader = undefined;
            this.readerReady = undefined;
          }
          throw error;
""", """          return undefined;
""", 'tests/journal-client-read-timeout.test.ts', 'retries a reader setup that timed out'),
    ('watch-cadence', 'packages/sdk/src/cli/running-step.ts',
     'const LEASE_POLL_MS = 2_000;', 'const LEASE_POLL_MS = 50;',
     'tests/running-step-watch.test.ts', 'uses pushes for completion'),
    ('snapshot-cancel', 'packages/sdk/src/cli/running-step.ts',
     'const signal = options.signal === undefined ? read.signal\n        : AbortSignal.any([options.signal, read.signal]);',
     'const signal = read.signal;',
     'tests/running-step-watch.test.ts', 'cancels promptly while a lease snapshot read is in flight'),
    ('completion-aborts-snapshot', 'packages/sdk/src/cli/running-step.ts',
     'snapshotRead?.abort(new Error(`step "${runningStep.id}" completed during the lease snapshot`));',
     '',
     'tests/running-step-watch.test.ts', 'a completion push ends the wait'),
    ('heartbeat', 'packages/sdk/src/worker-lease.ts',
     """      if (error instanceof JournalRequestTimeoutError && error.verb === 'step.heartbeat') {
        throw new WorkerLeaseLostError('renewal_expired', error.message, { cause: error });
      }
""", '', 'tests/heartbeat-timeout.test.ts', 'a heartbeat timeout'),
    ('root-parking', 'packages/sdk/src/authored-root.ts',
     """    if (isReadInterruptionError(error)
      || (error instanceof AuthoredFlowExecutionError && error.code === 'daemon_unresponsive')) {
      const parked = new AuthoredFlowExecutionError('daemon_unresponsive',
        `${error.message}. The run remains resumable. Continue with: ${resumeCommand(dispatch.run_id, options.dataDir, options.localAgentStream !== undefined)}.`);
      parked.rootRunId = dispatch.run_id;
      throw parked;
    }
""", '', 'tests/authored-root.test.ts', 'leaves the root resumable'),
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
