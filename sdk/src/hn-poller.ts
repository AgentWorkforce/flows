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

/** A transient failure confined to fetching the HN feed. */
export class HnPollFetchError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(`HN top stories fetch failed: ${String(cause)}`);
    this.name = 'HnPollFetchError';
    this.cause = cause;
  }
}

const defaultFetcher: Fetcher = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HN fetch failed: HTTP ${response.status}`);
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

  let body: string;
  try {
    body = await fetcher(TOP_STORIES_URL);
  } catch (cause) {
    throw new HnPollFetchError(cause);
  }

  let storyIds: unknown;
  try {
    storyIds = JSON.parse(body);
  } catch (cause) {
    throw new Error(`HN top stories response was not JSON: ${String(cause)}`);
  }
  if (!Array.isArray(storyIds)) {
    throw new Error('HN top stories response was not an array');
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
