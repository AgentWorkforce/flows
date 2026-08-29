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
    for (const { storyId, outcome } of submissions) {
      const wake = outcome.run === undefined || outcome.run === null ? 'none' : 'created';
      console.log(
        `Story ${String(storyId)}: matched=${outcome.matched} deduped=${outcome.deduped} wake=${wake}`,
      );
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
