#!/usr/bin/env python3
"""Typecheck the source and touched tests without emitting build artifacts."""
import json
import os
from pathlib import Path
import shlex
import subprocess

root = Path(__file__).resolve().parents[2]
sdk = root / 'packages/sdk'
config = sdk / '.tsconfig-review676.json'
assert not config.exists()
config.write_text(json.dumps({'extends': './tsconfig.tests.json', 'include': [
    'src/**/*.ts', 'tests/authored-node-admission.test.ts',
    'tests/authored-rollback-readback.test.ts', 'tests/authored-parallel-eligibility.test.ts',
    'tests/authored-node-result.test.ts', 'tests/authored-root.test.ts',
    'tests/authored-node-runtime.test.ts']}))
command = [os.environ['REVIEW_NODE'], 'node_modules/typescript/bin/tsc', '-p', config.name, '--noEmit']
try:
    result = subprocess.run(command, cwd=sdk, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    transcript = ('Temporary .tsconfig-review676.json:\n' + config.read_text()
                  + '\n$ cd packages/sdk\n$ ' + shlex.join(command) + '\n' + result.stdout
                  + '\nexit_code=' + str(result.returncode) + '\n')
    (Path(__file__).parent / 'logs/desktop-typecheck.txt').write_text(transcript)
    print(transcript)
finally:
    config.unlink()
raise SystemExit(result.returncode)
