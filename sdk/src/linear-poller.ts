/**
 * Linear -> relayflow events.
 *
 * Same shape as sdk/src/hn-poller.ts: this adapter runs on the authoring
 * surface (not kernel) and submits events through the journal protocol
 * (`event.submit`). The kernel learns about Linear the way it learns about
 * everything else: as an event. This preserves PR #16's settled decision
 * that provider-specific product logic + network I/O stay out of `kernel/`.
 *
 * Second proactive workload on gate 2 primitives (hn-monitor is the first),
 * per RFC-0001 §3 gate 2 ("hn-monitor or linear"). Proves the pattern
 * generalizes beyond the HN adapter.
 *
 * Auth: Linear requires an API token, unlike HN's public feed. The token is
 * read from `LINEAR_API_TOKEN` (env-configurable via the runner or CLI). In
 * a gate-6 world this would come from a relayfile-mounted credential, but
 * for gate-2 scope we accept the env-var bootstrap and note it in the flow's
 * preflight.
 *
 * Deduplication is the kernel's job (flow's `dedupeKeyTemplate` + the
 * (flow, subscription, key) claim). This function submits every issue it
 * fetches without tracking what it's seen.
 */

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
const DEFAULT_ISSUE_LIMIT = 10;

/** Anything that can submit an event through the journal protocol. */
export interface EventSink {
  eventSubmit(spec: unknown, event: { type: string; payload?: unknown; key?: string }): Promise<unknown>;
}

/** Injected so parsing and submission stay deterministic in tests. */
export type LinearFetcher = (query: string, token: string) => Promise<string>;

const defaultFetcher: LinearFetcher = async (query, token) => {
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: token,
    },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) {
    throw new Error(`Linear fetch failed: HTTP ${response.status}`);
  }
  return response.text();
};

/** Minimal issue shape used to construct the wake event payload. */
export interface LinearIssueRef {
  id: string;
  identifier?: string;
  title?: string;
  createdAt?: string;
  url?: string;
}

export interface PollOptions {
  /** Cap on issues per poll. Default 10. */
  issueLimit?: number;
  /** Fetcher override (tests). */
  fetcher?: LinearFetcher;
  /** API token override (production reads LINEAR_API_TOKEN env var). */
  token?: string;
  /** ISO timestamp filter — only fetch issues created after this. */
  createdAfter?: string;
}

/**
 * Fetch the newest Linear issues once and submit each as an event.
 *
 * Journal errors propagate; fetch errors propagate (the runner layer
 * decides what to swallow). Empty result is not an error.
 */
export async function pollLinearOnce(
  spec: unknown,
  sink: EventSink,
  options: PollOptions = {},
): Promise<unknown[]> {
  const issueLimit = options.issueLimit ?? DEFAULT_ISSUE_LIMIT;
  const fetcher = options.fetcher ?? defaultFetcher;
  const token = options.token ?? process.env['LINEAR_API_TOKEN'] ?? '';
  if (token === '') {
    throw new Error(
      'linear-poller: LINEAR_API_TOKEN is not set — provide options.token or set the env var',
    );
  }

  const createdAfter = options.createdAfter;
  // GraphQL: fetch newest issues, optionally filtered by createdAt.
  const filter = createdAfter
    ? `, filter: { createdAt: { gt: "${createdAfter}" } }`
    : '';
  const query = `
    query {
      issues(first: ${issueLimit}, orderBy: createdAt${filter}) {
        nodes {
          id
          identifier
          title
          createdAt
          url
        }
      }
    }
  `.trim();

  const body = await fetcher(query, token);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new Error(`Linear response was not JSON: ${String(cause)}`);
  }

  // Shape check — Linear returns { data: { issues: { nodes: [...] } } };
  // GraphQL errors surface as { errors: [...] }.
  if (parsed && typeof parsed === 'object' && 'errors' in parsed) {
    throw new Error(`Linear GraphQL error: ${JSON.stringify((parsed as any).errors)}`);
  }
  const nodes = (parsed as any)?.data?.issues?.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error('Linear response was missing data.issues.nodes array');
  }

  const outcomes: unknown[] = [];
  for (const node of nodes as LinearIssueRef[]) {
    if (!node || typeof node.id !== 'string') continue;
    outcomes.push(
      await sink.eventSubmit(spec, {
        type: 'linear.issue_created',
        payload: {
          id: node.id,
          identifier: node.identifier,
          title: node.title,
          created_at: node.createdAt,
          url: node.url,
          type: 'issue',
        },
      }),
    );
  }
  return outcomes;
}

export const LINEAR_GRAPHQL_ENDPOINT = LINEAR_GRAPHQL_URL;
