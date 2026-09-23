"""Revert one fix, capture failure, restore byte-for-byte, capture success."""
import pathlib
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parents[2]
sdk = root / 'packages/sdk'
mode = sys.argv[1]
if mode == 'cache':
    path = sdk / 'src/authored-worker-step.ts'
    before = 'await check(authoring)'
    after = 'await authoredPreflight(flowPath)(authoring)'
    pattern = 'deduplicates|completes nine'
elif mode == 'async':
    path = sdk / 'src/cli/cli-probe.ts'
    before = 'const sequence = probeSequence(...args);'
    after = 'return probeCli(...args);\n  const sequence = probeSequence(...args);'
    pattern = 'parallel llm capacity 1.*keeps the durable'
else:
    raise ValueError(mode)
original = path.read_bytes()
assert before.encode() in original

def run(label):
    command = ['npx', 'vitest', 'run', 'tests/authored-parallel-llm.test.ts', '-t', pattern]
    log = root / 'evidence/parallel-llm-fix' / f'mutation-{mode}-{label}.txt'
    with log.open('w') as out:
        out.write(f'cwd: packages/sdk\ncommand: {command!r}\n')
        out.flush()
        result = subprocess.run(command, cwd=sdk, stdout=out, stderr=subprocess.STDOUT)
        out.write(f'\nexit: {result.returncode}\n')
    return result.returncode

try:
    path.write_bytes(original.replace(before.encode(), after.encode(), 1))
    failed = run('reverted')
finally:
    path.write_bytes(original)
assert path.read_bytes() == original
print(f'{mode}: restored byte-for-byte', flush=True)
passed = run('restored')
assert failed != 0, 'mutation did not fail'
assert passed == 0, 'restored fix did not pass'
print(f'{mode}: reverted exit={failed}; restored exit={passed}', flush=True)
