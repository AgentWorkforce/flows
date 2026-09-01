/**
 * Hacker News -> relayflow events.
 *
 * This lives OUTSIDE `kernel/` deliberately. An earlier version called Hacker
 * News from `kernel/relayflowd` and review rejected it (PR #16, P1): a
 * durable-execution kernel must not own provider-specific product logic or
 * network I/O, or engine availability and dependencies become coupled to an
 * external service. The kernel gained a `ureq` dependency purely to fetch a
 * JSON feed — a clear sign the code was in the wrong place.
 *
 * So the adapter sits on the authoring surface and submits its events through
 * the journal protocol (`event.submit`), which is the same path any other
 * external producer would use. The kernel learns about Hacker News the way it
 * learns about everything else: as an event.
 */

const TOP_STORIES_URL = 'https://hacker-news.firebaseio.com/v0/topstories.json';
const DEFAULT_STORY_LIMIT = 5;

/** Anything that can submit an event through the journal protocol. */
export interface EventSink {
  eventSubmit(spec: unknown, event: { type: string; payload?: unknown; key?: string }): Promise<unknown>;
}

/** Injected so parsing and submission stay deterministic in tests. */
export type Fetcher = (url: string) => Promise<string>;

/**
 * Typed fetch-transport error. Callers (like sdk/src/cli/hn-monitor.ts)
 * `instanceof` this to distinguish transient HN fetch failures from
 * journal failures — avoids message-string matching (fragile cross-module
 * coupling) and covers the shapes fetch() itself throws (network errors,
 * ECONNREFUSED, TypeError('fetch failed')).
 */
export class HnTransientFetchError extends Error {
  constructor(message: string, cause?: unknown) {
    // Use the native ErrorOptions.cause path so stack formatting and
    // downstream inspectors (util.inspect, structured loggers) see it.
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'HnTransientFetchError';
  }
}

const defaultFetcher: Fetcher = async (url) => {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (cause) {
    // Network-layer failures from fetch() itself — TypeError('fetch failed'),
    // ECONNREFUSED, DNS lookup failures — are all transient.
    throw new HnTransientFetchError(`HN fetch failed: ${String(cause)}`, cause);
  }
  if (!response.ok) {
    throw new HnTransientFetchError(`HN fetch failed: HTTP ${response.status}`);
  }
  return response.text();
};

export interface PollOptions {
  storyLimit?: number;
  fetcher?: Fetcher;
  createdBy?: string;
}

/**
 * Fetch the top-stories feed once and submit each story as an event.
 *
 * Dedupe is the kernel's job, not ours: the flow's `dedupeKeyTemplate` plus the
 * (flow, subscription, key) claim means submitting the same story twice wakes
 * it once. This function deliberately does not track what it has already seen.
 */
export async function pollHackerNewsOnce(
  spec: unknown,
  sink: EventSink,
  options: PollOptions = {},
): Promise<unknown[]> {
  const storyLimit = options.storyLimit ?? DEFAULT_STORY_LIMIT;
  const fetcher = options.fetcher ?? defaultFetcher;

  const body = await fetcher(TOP_STORIES_URL);

  let storyIds: unknown;
  try {
    storyIds = JSON.parse(body);
  } catch (cause) {
    throw new HnTransientFetchError(`HN top stories response was not JSON: ${String(cause)}`);
  }
  if (!Array.isArray(storyIds)) {
    throw new HnTransientFetchError('HN top stories response was not an array');
  }

  const outcomes: unknown[] = [];
  for (const id of storyIds.slice(0, storyLimit)) {
    outcomes.push(
      await sink.eventSubmit(spec, {
        type: 'hn.story_posted',
        payload: { id, type: 'story' },
      }),
    );
  }
  return outcomes;
}

export const HN_TOP_STORIES_URL = TOP_STORIES_URL;
