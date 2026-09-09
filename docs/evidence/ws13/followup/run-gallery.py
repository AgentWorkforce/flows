"""Capture each requested gallery invocation, including nonzero exits and timeouts.
Usage: python3 run-gallery.py /absolute/gallery-clone /absolute/evidence-directory [research-default|sdk-only]
"""
from pathlib import Path
import json
import os
import shlex
import signal
import shutil
import subprocess
import sys
import time

root, evidence = (Path(p).resolve() for p in sys.argv[1:3])
evidence.mkdir(parents=True, exist_ok=True)
if any(evidence.glob('gallery-*.txt')):
    raise SystemExit('Choose an empty evidence directory; existing captures will not be overwritten.')
node = shutil.which('node')
if node is None:
    raise SystemExit('Node 22.18+ is required on PATH.')
version = subprocess.check_output([node, '-p', 'process.versions.node'], text=True, timeout=10).strip()
if tuple(map(int, version.split('.'))) < (22, 18, 0):
    raise SystemExit(f'Node 22.18+ is required on PATH; found {version} at {node}.')
cli = str(root / 'node_modules/relayflows/bin/flows.js')
cases = [
    ('dependency-upgrade-bot', 120, [node, cli, 'run',
        'examples/dependency-upgrade-bot/dependency-upgrade-bot.flow.ts', '--local-agent',
        '--input', '{}', '--data-dir', '/tmp/ws13-followup-upgrade-daemon']),
    ('pr-review-pipeline', 120, [node, cli, 'run',
        'examples/pr-review-pipeline/pr-review-pipeline.flow.ts', '--local-agent',
        '--input', '{"diffRange":"origin/main...HEAD"}',
        '--data-dir', '/tmp/ws13-followup-review-daemon']),
    ('research', 780, [node, '--experimental-strip-types', 'examples/research/shims/run.ts',
        '--slug', 'ws13-followup', '--question',
        'Compare durable step journals with deterministic replay. Keep every report under 200 words.',
        '--timeout-minutes', '3', '--runs-dir', '/tmp/ws13-research-followup-runs']),
]
if sys.argv[3:] == ['sdk-only']:
    cases = cases[:2]
elif sys.argv[3:] == ['research-default']:
    command = cases[-1][2].copy()
    command[command.index('ws13-followup')] = 'ws13-default-budget'
    index = command.index('--timeout-minutes')
    del command[index:index + 2]
    cases = [('research', 3900, command)]
results = []
for name, timeout, command in cases:
    with (evidence / f'gallery-{name}.txt').open('w') as output:
        output.write(f'$ cd {shlex.quote(str(root))}\n$ {shlex.join(command)}\n')
        output.write(f'OUTER_TIMEOUT_SECONDS={timeout}\n')
        output.flush()
        started = time.monotonic()
        process = subprocess.Popen(command, cwd=root,
            env=os.environ.copy(),
            stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        timed_out = False
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            code = 124
        elapsed = round(time.monotonic() - started, 3)
        output.write(f'\nEXIT_CODE={code}\nELAPSED_SECONDS={elapsed:.3f}\nTIMED_OUT={timed_out}\n')
    result = {'example': name, 'exitCode': code, 'elapsedSeconds': elapsed, 'timedOut': timed_out}
    results.append(result)
    (evidence / 'gallery-results.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps(result), flush=True)
