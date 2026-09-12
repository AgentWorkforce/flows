import { githubClient as upstreamGithub, notionClient as upstreamNotion, created } from '@relayfile/relay-helpers';
import type { RelayClientOptions } from '@relayfile/relay-helpers/transport';

/** Accept the conventional owner/repo shorthand as well as upstream arguments. */
export function githubClient(options: RelayClientOptions) {
  const client = upstreamGithub(options);
  return { ...client, createIssue(args: { owner?: string; repo: string; title: string; body: string; labels?: string[] }) {
    const [owner, repo, extra] = args.repo.split('/');
    if (!args.owner && (!owner || !repo || extra)) throw new Error('github.createIssue requires repo: "owner/repo" or an explicit owner');
    return client.createIssue({ ...args, owner: args.owner ?? owner!, repo: args.owner ? args.repo : repo! });
  } };
}

export function stripeClient(options: RelayClientOptions) {
  return { createInvoice(args: { customer: string; auto_advance?: boolean; collection_method?: 'charge_automatically' | 'send_invoice'; days_until_due?: number; description?: string; metadata?: Record<string, string> }) {
    if (!options.transport) throw new Error('Stripe requires a journal transport');
    return created(options.transport.write({ provider: 'stripe', resource: 'invoices',
      parameters: {}, path: '/stripe/invoices', body: args }));
  } };
}

export function notionClient(options: RelayClientOptions) {
  return { ...upstreamNotion(options), async appendBlock(args: { pageId: string; block: Record<string, unknown> }) {
    if (!options.transport) throw new Error('Notion requires a journal transport');
    // The adapter does not yet support this route. The runtime refuses it in
    // mount mode, while mock mode can exercise authoring and effect lowering.
    return created(options.transport.write({ provider: 'notion', resource: 'blocks',
      parameters: { pageId: args.pageId }, path: `/notion/pages/${encodeURIComponent(args.pageId)}/blocks`, body: { children: [args.block] } }));
  } };
}
