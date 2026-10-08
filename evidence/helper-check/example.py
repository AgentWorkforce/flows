from pathlib import Path
import os, shlex, subprocess
boundary = Path('examples/stale-issues/package.json')
assert not boundary.exists()
env = os.environ.copy()
keys = ['SLACK_BOT_TOKEN', 'RELAYFLOWS_SLACK_MOCK', 'RELAYFILE_MOUNT_PATH',
        'WORKSPACE_ROOT', 'WORKFORCE_SANDBOX_ROOT', 'RELAYFILE_MOUNT_ROOT', 'RELAYFILE_ROOT']
for key in keys:
    env.pop(key, None)
# This checkout lacks a module boundary for examples; the installed CLI normally
# runs in an author's module project. Restore the checkout even on failure.
boundary.write_text('{"type":"module"}\n')
try:
    for verb in ['check', 'run']:
        cmd = ['node', 'packages/sdk/dist/cli.js', verb, 'examples/stale-issues/stale-issues.flow.ts']
        if verb == 'run':
            cmd += ['--input', '{"repo":"acme/api","channel":"#eng"}']
        result = subprocess.run(cmd, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        print('$ env ' + ' '.join('-u ' + key for key in keys) + ' ' + shlex.join(cmd))
        print(result.stdout, end='')
        print(f'exit={result.returncode}')
finally:
    boundary.unlink()
