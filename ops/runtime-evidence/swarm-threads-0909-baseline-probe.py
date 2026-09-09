"""Run the original PR self-test with the corrected whole-second comparator."""
import os
from pathlib import Path
import subprocess
import tempfile

root = Path.cwd()
Path('.relayflow').mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(dir='.relayflow', prefix='swarm-baseline-') as directory:
    target = Path(directory).resolve()
    for name in ['swarm-gate.test.sh', 'swarm-post.sh', 'swarm-verdict.sh']:
        source = f'066e2deecea5ffb88fdce088a98da111b547d803:.github/workflows/scripts/{name}'
        (target / name).write_bytes(subprocess.check_output(['git', 'show', source]))
    env = dict(os.environ, BASH_ENV=str(root / 'ops/runtime-evidence/swarm-threads-0909-coarse.bash'))
    # This is a timing race; preserve every attempt, including passing ones.
    for attempt in range(1, 6):
        result = subprocess.run(['bash', str(target / 'swarm-gate.test.sh')], env=env,
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        print(f'BASELINE_ATTEMPT={attempt}')
        print(result.stdout, end='')
        print(f'EXIT_CODE={result.returncode}')
        if result.returncode:
            raise SystemExit(result.returncode)
    print('NO_FAILURE_OBSERVED_IN_FIVE_ATTEMPTS')
