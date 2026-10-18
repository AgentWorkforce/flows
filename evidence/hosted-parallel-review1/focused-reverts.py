#!/usr/bin/env python3
"""Focused mutation evidence only; does not build or run the live review gate."""
import difflib
import hashlib
import os
from pathlib import Path
import shlex
import subprocess

root = Path(__file__).resolve().parents[2]
sdk = root / 'packages/sdk'
logs = Path(__file__).resolve().parent / 'logs'
node = os.environ['REVIEW_NODE']
old_sdk = os.environ['FLOWS_2052_SDK']


def test(tag, tests, prefix=''):
    command = [node, 'node_modules/vitest/vitest.mjs', 'run', *tests,
               '--maxWorkers=1', '--minWorkers=1']
    result = subprocess.run(command, cwd=sdk, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True)
    transcript = (prefix + '$ cd packages/sdk\n$ FLOWS_2052_SDK=' + shlex.quote(old_sdk)
                  + ' ' + shlex.join(command) + '\n' + result.stdout
                  + '\nexit_code=' + str(result.returncode) + '\n')
    (logs / (tag + '.txt')).write_text(transcript)
    print(tag + ':\n' + '\n'.join(line for line in result.stdout.splitlines()
          if 'Test Files ' in line or 'Tests ' in line) + '\nexit_code=' + str(result.returncode), flush=True)
    return result.returncode


root_calls = """await parallelLoadedBodyEligible(definition.body, source.toString('utf8'), pathToFileURL(loaded.sourcePath).href, 'strip')
          || await parallelLoadedBodyEligible(definition.body, source.toString('utf8'), pathToFileURL(loaded.sourcePath).href, 'transform')"""
edge_check = """
          || step.label !== matching.label || step.afterTruncated !== matching.afterTruncated
          || (step.after === undefined ? matching.after !== undefined
            : !Array.isArray(step.after) || !Array.isArray(matching.after) || step.after.length !== matching.after.length
              || step.after.some((id, index) => id !== matching.after?.[index]))"""
mutations = [
    ('f1-body-identity', 'authored-parallel-eligibility.ts', [
        ('return parallelRunEligible(body, transformed);', 'return parallelBodySyntaxEligible(body);')],
     ['tests/authored-parallel-eligibility.test.ts']),
    ('f3-type-identity', 'authored-root.ts', [
        ('const { parallelLoadedBodyEligible, parallelPinnedSourceEligible }',
         'const { parallelRunEligible, parallelPinnedSourceEligible }'),
        (root_calls, "parallelRunEligible(definition.body, source.toString('utf8'))")],
     ['tests/authored-root.test.ts']),
    ('f4-root-marker', 'authored-root.ts', [
        ("kind: executionMode === 'parallel' ? AUTHORED_PARALLEL_ROOT_KIND_V3 : ROOT_KIND,",
         "kind: executionMode === 'parallel' ? AUTHORED_PARALLEL_ROOT_KIND : ROOT_KIND,")],
     ['tests/authored-root.test.ts']),
    ('f5-step-metadata', 'authored-node-runner.ts', [(edge_check, '')],
     ['tests/authored-node-result.test.ts']),
    ('wip-strip-mode', 'authored-root.ts', [
        (root_calls, "await parallelLoadedBodyEligible(definition.body, source.toString('utf8'), pathToFileURL(loaded.sourcePath).href, 'transform')")],
     ['tests/authored-root.test.ts']),
]

for tag, filename, changes, tests in mutations:
    path = sdk / 'src' / filename
    original = path.read_bytes()
    before = hashlib.sha256(original).hexdigest()
    mutant = original.decode()
    for old, new in changes:
        assert mutant.count(old) == 1, (tag, old)
        mutant = mutant.replace(old, new)
    diff = ''.join(difflib.unified_diff(original.decode().splitlines(True),
                   mutant.splitlines(True), fromfile=filename, tofile=filename + ' (reverted)'))
    try:
        path.write_text(mutant)
        failed = test(tag + '-reverted', tests, diff + '\n')
    finally:
        path.write_bytes(original)
    assert path.read_bytes() == original
    restored = test(tag + '-restored', tests,
                    'Restored byte-for-byte: ' + filename + '\nsha256=' + before + '\n')
    assert failed != 0 and restored == 0, (tag, failed, restored)

assert test('desktop-focused', [
    'tests/authored-node-admission.test.ts', 'tests/authored-rollback-readback.test.ts',
    'tests/authored-parallel-eligibility.test.ts', 'tests/authored-node-result.test.ts',
    'tests/authored-root.test.ts', 'tests/authored-status-detail.test.ts']) == 0
