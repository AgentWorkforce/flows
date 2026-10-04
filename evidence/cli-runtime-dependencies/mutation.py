"""Run from the repository root after building surface and SDK."""
import json
from pathlib import Path
import shlex
import subprocess

root = Path.cwd()
evidence = root / 'evidence/cli-runtime-dependencies'
manifest = root / 'packages/sdk/package.json'
lock = root / 'packages/sdk/package-lock.json'
original = {path: path.read_bytes() for path in (manifest, lock)}

def run(name, command, cwd=root, expected=0):
    result = subprocess.run(command, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    transcript = f'$ cd {cwd}\n$ {shlex.join(command)}\n{result.stdout}\nexit={result.returncode}\n'
    (evidence / name).write_text(transcript)
    print(transcript, flush=True)
    assert result.returncode == expected, f'{name}: unexpected exit'
    return result.stdout

try:
    data = json.loads(manifest.read_text())
    data['devDependencies']['typescript'] = data['dependencies'].pop('typescript')
    manifest.write_text(json.dumps(data, indent=2) + '\n')
    output = run('imports-fail.txt', ['./node_modules/.bin/vitest', 'run', 'tests/runtime-dependencies.test.ts'], root / 'packages/sdk', 1)
    assert 'typescript' in output and 'undici' not in output
    run('mutation-lock.txt', ['npm', 'install', '--prefix', 'packages/sdk', '--package-lock-only', '--ignore-scripts'])
    output = run('package-fail.txt', ['node', 'scripts/cli-package-gate.mjs'], expected=1)
    assert 'ERR_MODULE_NOT_FOUND' in output and "Cannot find package 'typescript'" in output and 'check-activities.js' in output
finally:
    for path, contents in original.items():
        path.write_bytes(contents)
    assert all(path.read_bytes() == contents for path, contents in original.items())
    print('Restored manifest and lock byte-for-byte.', flush=True)

run('mutation-restore.txt', ['git', 'diff', '--exit-code', '--', 'packages/sdk/package.json', 'packages/sdk/package-lock.json'])
run('imports-pass.txt', ['./node_modules/.bin/vitest', 'run', 'tests/runtime-dependencies.test.ts'], root / 'packages/sdk')
run('package-pass.txt', ['node', 'scripts/cli-package-gate.mjs'])
