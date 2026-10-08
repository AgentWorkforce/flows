"""Run the reviewed mutations in an isolated copy so concurrent suites stay pristine."""
from pathlib import Path
import hashlib
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[2]
source = repo / 'packages/sdk'
evidence = repo / 'evidence/daemon-check'
with tempfile.TemporaryDirectory(prefix='daemon-check-mutation-') as directory:
    root = Path(directory)
    sdk = root / 'packages/sdk'
    sdk.mkdir(parents=True)
    for name in ['src', 'dist']:
        shutil.copytree(source / name, sdk / name)
    for name in ['package.json', 'vitest.config.ts']:
        shutil.copy2(source / name, sdk / name)
    (sdk / 'tests').mkdir()
    for name in ['check-daemon-validation.test.ts', 'isolate-workspace.ts']:
        shutil.copy2(source / 'tests' / name, sdk / 'tests' / name)
    (sdk / 'node_modules').symlink_to(source / 'node_modules', target_is_directory=True)
    (root / 'testdata').symlink_to(repo / 'testdata', target_is_directory=True)
    files = [sdk / 'src/daemon-spec-validation.ts', sdk / 'dist/daemon-spec-validation.js']
    originals = {p: p.read_bytes() for p in files}
    cases = [
        ('refusal', 'if (verdict.ok)', 'if (true)', [
            ('unit', 'refuses package-valid daemon-invalid skew through check'),
            ('cli', 'real CLI refuses skew in auto and required modes'),
        ]),
        ('indices', 'submitted.steps[Number(index)]?.id', 'flow.steps[Number(index)]?.id', [
            ('generated', 'maps generated-step indices'),
            ('authored', 'maps authored steps following generated steps'),
        ]),
    ]
    for name, before, after, tests in cases:
        for path, original in originals.items():
            text = original.decode()
            assert before in text, (path, before)
            path.write_text(text.replace(before, after))
        for phase in ['mutated', 'restored']:
            if phase == 'restored':
                for path, original in originals.items():
                    path.write_bytes(original)
                    assert path.read_bytes() == original
            for label, test in tests:
                command = ['node', str(source / 'node_modules/vitest/vitest.mjs'), 'run',
                    'tests/check-daemon-validation.test.ts', '-t', test]
                result = subprocess.run(command, cwd=sdk, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                output = evidence / f'mutation-{name}-{label}-{phase}.txt'
                output.write_text('$ ' + ' '.join(repr(arg) for arg in command) + '\n'
                    + f'cwd: {sdk}\n' + result.stdout + f'\nexit={result.returncode}\n')
                print(f'{output.name}: exit={result.returncode}', flush=True)
                assert (result.returncode != 0) if phase == 'mutated' else (result.returncode == 0)
        for path, original in originals.items():
            print(f'Restored byte-for-byte: {path.relative_to(sdk)} sha256={hashlib.sha256(original).hexdigest()}', flush=True)
