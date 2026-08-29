import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pollHackerNewsOnce, type EventSink } from './hn-poller.js';
import { JournalClient } from './journal-client.js';
import type { EventSubmitResult } from './protocol.js';

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(sdkRoot, '..');
const dataDir = resolve(process.env.RELAYFLOW_DATA_DIR ?? join(repositoryRoot, '.relayflowd'));
const socketPath = join(dataDir, 'relayflowd.sock');
const specPath = join(repositoryRoot, 'testdata', 'hn-monitor.spec.canonical.json');

interface Submission {
  storyId: unknown;
  outcome: EventSubmitResult;
}

async function main(): Promise<void> {
  const spec: unknown = JSON.parse(await readFile(specPath, 'utf8'));
  const client = new JournalClient(socketPath);

  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `No relayflowd is listening at "${socketPath}". Start it with: relayflowd --data-dir "${dataDir}" serve`,
      { cause: error },
    );
  }

  try {
    await client.hello('hn-monitor-demo');
    const submissions: Submission[] = [];
    const sink: EventSink = {
      async eventSubmit(submittedSpec, event) {
        const outcome = await client.eventSubmit(submittedSpec, event);
        submissions.push({ storyId: storyId(event.payload), outcome });
        return outcome;
      },
    };

    console.log('Fetching live Hacker News top stories...');
    await pollHackerNewsOnce(spec, sink);

    let woke = 0;
    for (const { storyId, outcome } of submissions) {
      const wake = outcome.run === undefined || outcome.run === null ? 'none' : 'created';
      if (wake === 'created') woke += 1;
      console.log(
        `Story ${String(storyId)}: matched=${outcome.matched} deduped=${outcome.deduped} wake=${wake}`,
      );
    }

    // Say exactly what was proven, and no more.
    //
    // A wake is a run being CREATED. It is not the flow's steps being
    // EXECUTED — that needs an agent worker attached to the kernel, and
    // `relayflowd serve` alone does not provide one. Review caught this
    // (PR #19, P1): the first version of this demo printed created wakes and
    // let the reader conclude a workload had run. It had not.
    //
    // The distinction is the whole of RFC-0001 §3 gate 2: "a real proactive
    // workload RUNS as a relayflow" is a claim about execution, not about
    // enqueueing.
    console.log('');
    if (woke > 0) {
      console.log(`PROVEN: ${woke} run(s) created from live Hacker News data via event.submit.`);
      console.log('        The event path — fetch, match, dedupe claim, wake — works end to end.');
      console.log('');
      console.log('NOT PROVEN: that those runs EXECUTED. No agent worker is attached to this');
      console.log('        kernel, so each run is created and then waits. Gate 2 asks whether a');
      console.log('        workload RUNS as a relayflow; this shows it is woken, not that it ran.');
      console.log('        Attach a worker and re-run to close that gap.');
    } else {
      console.log('No runs were created. Either every story was already claimed (dedupe working');
      console.log('as intended on a repeat poll), or nothing matched the subscription.');
    }
  } finally {
    client.close();
  }
}

function storyId(payload: unknown): unknown {
  if (typeof payload === 'object' && payload !== null && 'id' in payload) {
    return payload.id;
  }
  return 'unknown';
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
