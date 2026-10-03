import subprocess, pathlib, json, hashlib
root = pathlib.Path.cwd()
evidence = root / 'evidence/packaged-cli'
manifest = root / 'packages/sdk/package.json'
lock = root / 'packages/sdk/package-lock.json'
original = {p: p.read_bytes() for p in (manifest, lock)}

def run(command, out):
    out.write('$ ' + command + '\n'); out.flush()
    result = subprocess.run(command, shell=True, executable='/bin/bash', cwd=root, stdout=out, stderr=subprocess.STDOUT)
    out.write(f'\nEXIT_CODE={result.returncode}\n'); out.flush()
    return result.returncode

def checks(label, expected):
    for gate, command in [
        ('closure', 'cd packages/sdk && ../../packages/sdk/node_modules/.bin/vitest run tests/runtime-dependencies.test.ts'),
        ('install', 'npm exec --yes --package=node@22 -- bash scripts/packaged-cli-gate.sh'),
    ]:
        with (evidence / f'{label}-{gate}.txt').open('w') as out:
            out.write(f'State: {label}\n')
            status = run(command, out)
            if (status == 0) != expected:
                raise RuntimeError(f'{label}-{gate}: unexpected exit {status}')
        print(f'{label}-{gate}: exit {status}', flush=True)

try:
    for name in ('typescript', 'undici'):
        with (evidence / f'{name}-mutation.txt').open('w') as out:
            command = "python3 - <<'PYCODE'\nimport json\nfrom pathlib import Path\np = Path('packages/sdk/package.json')\nd = json.loads(p.read_text())\nversion = d['dependencies'].pop('" + name + "')\n"
            if name == 'typescript':
                command += "d['devDependencies']['typescript'] = version\n"
            command += "p.write_text(json.dumps(d, indent=2) + '\\n')\nPYCODE"
            assert run(command, out) == 0
            assert run('npm install --prefix packages/sdk --package-lock-only --ignore-scripts --no-audit --no-fund', out) == 0
            assert run('npm ci --prefix packages/sdk --dry-run --ignore-scripts', out) == 0
        checks(f'{name}-missing', False)
        for path, content in original.items():
            path.write_bytes(content)
        with (evidence / f'{name}-restore.txt').open('w') as out:
            out.write('Restored package.json and package-lock.json byte-for-byte from saved fixed bytes.\n')
            assert run('npm install --prefix packages/sdk --package-lock-only --ignore-scripts --no-audit --no-fund', out) == 0
            assert run('npm ci --prefix packages/sdk --dry-run --ignore-scripts', out) == 0
            for path, content in original.items():
                assert path.read_bytes() == content, path
                out.write(f'SHA256 {path.relative_to(root)} {hashlib.sha256(content).hexdigest()} (matches saved fixed bytes)\n')
        checks(f'{name}-restored', True)
finally:
    for path, content in original.items():
        path.write_bytes(content)
