# Mutation commands and literal captured output

## cache

Command: `python evidence/parallel-llm-fix/mutate.py cache`

### reverted

```text
cwd: packages/sdk
command: ['npx', 'vitest', 'run', 'tests/authored-parallel-llm.test.ts', '-t', 'deduplicates|completes nine']

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ❯ tests/authored-parallel-llm.test.ts (6 tests | 4 failed | 2 skipped) 22493ms
   × parallel llm capacity 1 > deduplicates concurrent preflight probes 3643ms
     → expected [ 'test-model', 'test-model', …(7) ] to have a length of 1 but got 9
   × parallel llm capacity 1 > completes nine calls without expired child leases during slow preflight 10266ms
     → expected [ 'test-model', 'test-model', …(7) ] to have a length of 1 but got 9
   × parallel llm capacity 4 > deduplicates concurrent preflight probes 1273ms
     → expected [ 'test-model', 'test-model', …(7) ] to have a length of 1 but got 9
   × parallel llm capacity 4 > completes nine calls without expired child leases during slow preflight 7311ms
     → expected [ 'test-model', 'test-model', …(7) ] to have a length of 1 but got 9

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/authored-parallel-llm.test.ts > parallel llm capacity 1 > deduplicates concurrent preflight probes
 FAIL  tests/authored-parallel-llm.test.ts > parallel llm capacity 4 > deduplicates concurrent preflight probes
AssertionError: expected [ 'test-model', 'test-model', …(7) ] to have a length of 1 but got 9

- Expected
+ Received

- 1
+ 9

 ❯ Object.assertProbes tests/authored-parallel-llm.test.ts:61:27
     59|   }
     60|   return { fixture, client, assertJournals, assertProbes(count: number…
     61|     expect(lines(probes)).toHaveLength(count);
       |                           ^
     62|   }, assertCapacity() {
     63|     const intervals = lines(spans) as Array<{ start: number; end: numb…
 ❯ tests/authored-parallel-llm.test.ts:86:10

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/4]⎯

 FAIL  tests/authored-parallel-llm.test.ts > parallel llm capacity 1 > completes nine calls without expired child leases during slow preflight
 FAIL  tests/authored-parallel-llm.test.ts > parallel llm capacity 4 > completes nine calls without expired child leases during slow preflight
AssertionError: expected [ 'test-model', 'test-model', …(7) ] to have a length of 1 but got 9

- Expected
+ Received

- 1
+ 9

 ❯ Object.assertProbes tests/authored-parallel-llm.test.ts:61:27
     59|   }
     60|   return { fixture, client, assertJournals, assertProbes(count: number…
     61|     expect(lines(probes)).toHaveLength(count);
       |                           ^
     62|   }, assertCapacity() {
     63|     const intervals = lines(spans) as Array<{ start: number; end: numb…
 ❯ tests/authored-parallel-llm.test.ts:99:10

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/4]⎯

 Test Files  1 failed (1)
      Tests  4 failed | 2 skipped (6)
   Start at  05:53:12
   Duration  23.80s (transform 596ms, setup 0ms, collect 1.13s, tests 22.49s, environment 0ms, prepare 42ms)


exit: 1

```

### restored

```text
cwd: packages/sdk
command: ['npx', 'vitest', 'run', 'tests/authored-parallel-llm.test.ts', '-t', 'deduplicates|completes nine']

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ✓ tests/authored-parallel-llm.test.ts (6 tests | 2 skipped) 20071ms
   ✓ parallel llm capacity 1 > deduplicates concurrent preflight probes 2799ms
   ✓ parallel llm capacity 1 > completes nine calls without expired child leases during slow preflight 8690ms
   ✓ parallel llm capacity 4 > deduplicates concurrent preflight probes 1311ms
   ✓ parallel llm capacity 4 > completes nine calls without expired child leases during slow preflight 7270ms

 Test Files  1 passed (1)
      Tests  4 passed | 2 skipped (6)
   Start at  05:53:37
   Duration  21.25s (transform 569ms, setup 0ms, collect 1.01s, tests 20.07s, environment 0ms, prepare 49ms)


exit: 0

```

Restoration check:

```text
cache: restored byte-for-byte
cache: reverted exit=1; restored exit=0

```

## async

Command: `python evidence/parallel-llm-fix/mutate.py async`

### reverted

```text
cwd: packages/sdk
command: ['npx', 'vitest', 'run', 'tests/authored-parallel-llm.test.ts', '-t', 'parallel llm capacity 1.*keeps the durable']

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ❯ tests/authored-parallel-llm.test.ts (6 tests | 1 failed | 5 skipped) 91068ms
   × parallel llm capacity 1 > keeps the durable root lease alive across two cold models 91067ms
     → lease_conflict: attempt has no active worker lease

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/authored-parallel-llm.test.ts > parallel llm capacity 1 > keeps the durable root lease alive across two cold models
JournalProtocolError: lease_conflict: attempt has no active worker lease
 ❯ JournalClient.onLine src/journal-client.ts:165:27
    163|       if (pending.timer !== undefined) clearTimeout(pending.timer);
    164|       if (res.ok) pending.resolve(res.result);
    165|       else pending.reject(new JournalProtocolError(res.error.code, res…
       |                           ^
    166|     } else {
    167|       const ev = msg as ServerEvent;
 ❯ JournalClient.onData src/journal-client.ts:144:33
 ❯ Socket.<anonymous> src/journal-client.ts:109:43

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 5 skipped (6)
   Start at  05:53:59
   Duration  92.22s (transform 560ms, setup 0ms, collect 978ms, tests 91.07s, environment 0ms, prepare 46ms)


exit: 1

```

### restored

```text
cwd: packages/sdk
command: ['npx', 'vitest', 'run', 'tests/authored-parallel-llm.test.ts', '-t', 'parallel llm capacity 1.*keeps the durable']

 RUN  v2.1.9 /home/daytona/.relayflow-v2-supervisor/durable/repository/packages/sdk

 ✓ tests/authored-parallel-llm.test.ts (6 tests | 5 skipped) 47947ms
   ✓ parallel llm capacity 1 > keeps the durable root lease alive across two cold models 47946ms

 Test Files  1 passed (1)
      Tests  1 passed | 5 skipped (6)
   Start at  05:55:31
   Duration  49.09s (transform 558ms, setup 0ms, collect 978ms, tests 47.95s, environment 0ms, prepare 43ms)


exit: 0

```

Restoration check:

```text
async: restored byte-for-byte
async: reverted exit=1; restored exit=0

```
