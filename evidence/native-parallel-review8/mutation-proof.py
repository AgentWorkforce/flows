#!/usr/bin/env python3
"""Run selected review-7 guard removals, then restore each file byte for byte."""

from hashlib import sha256
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
SDK = ROOT / 'packages/sdk'
OUT = Path(__file__).resolve().parent
VITEST = SDK / 'node_modules/.bin/vitest'

CASES = [
    (
        'f1-parens', 'src/authored-parallel-body.ts',
        'const member = unwrapParallelExpression(outer);', 'const member = outer;',
        'tests/authored-parallel-body.test.ts',
        'certifies every parenthesized branch member accepted by the grammar',
    ),
    (
        'f2-name', 'src/authored-parallel-eligibility.ts',
        'if (namesCertifier) return false;', 'if (false && namesCertifier) return false;',
        'tests/authored-parallel-eligibility.test.ts',
        'uses serial mode when the body names the injected certifier',
    ),
    (
        'f3-preload', 'src/authored-flow-lifecycle.ts',
        'if (!nativeAtModuleLoad || authoredProcessHasPreload()',
        'if (!nativeAtModuleLoad || false',
        'tests/authored-flow-lifecycle-executor.test.ts',
        'detects replacement of every Promise primitive used by parallel joins',
    ),
    (
        'f4-member', 'src/authored-flow-lifecycle.ts',
        'if (this.refuseUnknownThenable !== undefined) {',
        'if (false && this.refuseUnknownThenable !== undefined) {',
        'tests/authored-flow-lifecycle-executor.test.ts',
        'refuses untracked thenables before invoking their user-supplied then',
    ),
    (
        'f6-descriptors', 'src/authored-flow-lifecycle.ts',
        'function sameDescriptor(actual: PropertyDescriptor | undefined, original: PropertyDescriptor | undefined): boolean {',
        'function sameDescriptor(actual: PropertyDescriptor | undefined, original: PropertyDescriptor | undefined): boolean { return true;',
        'tests/authored-flow-lifecycle-executor.test.ts',
        'detects replacement of every Promise primitive used by parallel joins',
    ),
]


def run(name: str, phase: str, test: str, title: str) -> int:
    command = [str(VITEST), 'run', test, '-t', title]
    result = subprocess.run(command, cwd=SDK, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, check=False)
    target = OUT / f'mut-{name}-{phase}.log'
    target.write_bytes(result.stdout)
    print(f'{name} {phase}: exit={result.returncode}; command={" ".join(command)}; log={target.relative_to(ROOT)}')
    return result.returncode


for name, relative, before, after, test, title in CASES:
    source = SDK / relative
    original = source.read_bytes()
    before_bytes = before.encode()
    if original.count(before_bytes) != 1:
        raise SystemExit(f'{name}: expected one mutation target in {relative}')
    digest = sha256(original).hexdigest()
    try:
        source.write_bytes(original.replace(before_bytes, after.encode(), 1))
        failed = run(name, 'fail', test, title)
    finally:
        source.write_bytes(original)
    restored = source.read_bytes()
    if restored != original or sha256(restored).hexdigest() != digest:
        raise SystemExit(f'{name}: byte-for-byte restoration failed')
    print(f'{name}: restored SHA-256 {digest}')
    if failed == 0:
        raise SystemExit(f'{name}: selected test unexpectedly passed after guard removal')
    if b'AssertionError' not in (OUT / f'mut-{name}-fail.log').read_bytes():
        raise SystemExit(f'{name}: failure was not the selected assertion')
    if run(name, 'pass', test, title) != 0:
        raise SystemExit(f'{name}: selected test failed after restoration')

print(f'{len(CASES)}/{len(CASES)} selected mutations failed and passed after byte-for-byte restoration')
