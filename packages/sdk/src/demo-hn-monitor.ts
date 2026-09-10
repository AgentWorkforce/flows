import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { socketPathFor } from './daemon-connection.js';
import { pollHackerNewsOnce, type EventSink } from './hn-poller.js';
import { JournalClient } from './journal-client.js';
import type { EventSubmitResult } from './protocol.js';

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(sdkRoot, '..');
const dataDir = resolve(process.env.RELAYFLOW_DATA_DIR ?? join(repositoryRoot, '.relayflowd'));
const socketPath = socketPathFor(dataDir);
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
    const createdRunIds: string[] = [];
    for (const { storyId, outcome } of submissions) {
      const wake = outcome.run === undefined || outcome.run === null ? 'none' : 'created';
      if (wake === 'created') {
        woke += 1;
        const runId = typeof outcome.run === 'string' ? outcome.run : (outcome.run as { run_id?: string })?.run_id;
        if (runId) createdRunIds.push(runId);
      }
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

      // Do not ASSERT that nothing executed — ask the kernel and report what it
      // says. The first version of this block hardcoded "no agent worker is
      // attached", which would have been a false statement the moment someone
      // attached one. Evidence is captured, not narrated.
      const observed = createdRunIds[0];
      if (observed === undefined) {
        console.log('NOT PROVEN: that those runs EXECUTED — no run id came back to inspect.');
      } else {
        const snapshot = await client.runGet(observed);
        const steps = Object.entries(snapshot.steps);
        // A run nobody works sits in `runnable` — ready, with no worker to
        // claim it. So "not pending" is NOT evidence of execution; only a step
        // that reached `running` or `done` proves a worker picked it up.
        const executed = steps.filter(([, step]) => step.state === 'running' || step.state === 'done').length;
        const stateCounts = steps.map(([id, step]) => `${id}=${step.state}`).join(' ');
        console.log(`Observed run ${observed}: status=${snapshot.status}, steps: ${stateCounts}`);
        if (executed === 0) {
          console.log('');
          console.log('NOT PROVEN: that those runs EXECUTED. No step reached running or done,');
          console.log('        which is what a created-but-unworked run looks like: `relayflowd serve`');
          console.log('        alone attaches no agent worker. Gate 2 asks whether a workload RUNS');
          console.log('        as a relayflow; this shows it is woken, not that it ran.');
          // Ordering matters, and the obvious advice is wrong. A run that
          // finds no worker parks; attaching one AFTERWARDS does not re-drive
          // it, because nothing revisits parked runs. Measured on the live
          // kernel: attach-then-submit dispatches, submit-then-attach does not
          // until run.resume is called.
          console.log('        To close it, the worker must be attached BEFORE these events are');
          console.log('        submitted — attaching afterwards does not re-drive a parked run.');
          console.log('        Already parked? Call run.resume on it once a worker is attached.');
        } else {
          console.log('');
          console.log(`ALSO PROVEN: execution happened — ${String(executed)} step(s) reached`);
          console.log('        running or done, so a worker claimed this run. That is gate 2 proper.');
        }
      }
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
