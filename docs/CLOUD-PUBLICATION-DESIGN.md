# Cloud run publication and gallery — design only

Status: **DESIGN ONLY — DO NOT BUILD.** The rollout coordinator relayed Khaliq's
revised WS-14 scope on 2026-09-08: no standalone showcase app, gallery site, or
gallery route; no publication backend implementation. Publishing requires a
new endpoint in the Cloud repository, outside this lane, with no assigned owner.
The written design is the deliverable; implementation is not an acceptance
dependency for WS-14. Every endpoint, scope, type, and URL below is proposed,
not an existing callable API. The SDK does not export `publishFlowRun` today.

The built portion of WS-14 is declarative `runInCloud` plus cancellable
observation. The live proof is **BLOCKED-ON-CREDENTIAL**; the captured result is
`Authenticated Cloud-base-path read HTTP: 401`. No further credential probing is
part of this lane. Hosted authored TypeScript is a backend limitation: the
current v2 runtime accepts YAML/JSON and explicitly rejects `.flow.ts`.

## Product contract

An author deliberately publishes a fixed, limited projection of a real run. One
stable public URL identifies that publication across visibility changes. A
gallery lists public publications only. Publication does not change execution,
run completion, journal entries, or verification outcomes; the journal remains
the source of truth. A publication never turns an observer projection into an
execution authority.

Proposed SDK surface:

```ts
const published = await publishFlowRun(runId, {
  visibility: 'unlisted', // required: private | unlisted | public
  title: 'Dependency upgrade with a deterministic gate', // optional, explicit
});
console.log(published.url); // absent for private visibility
```

Connection/authentication options follow `runInCloud`. The client sends a run
ID and publication options, never a caller-supplied run result or journal. This
function belongs in the SDK; a future CLI would only parse and call it. The
server owns authorization, snapshot derivation, storage, and visibility.

## Proposed endpoint shapes

Paths are relative to the Cloud application base URL, currently
`https://agentrelay.com/cloud`.

| Method and path | Purpose | Authentication |
| --- | --- | --- |
| `POST /api/v1/workflows/runs/:runId/publication/preview` | Derive the exact default public projection, with digest and source revision | Owner/delegate Cloud token with run-read and publication-write scopes |
| `POST /api/v1/workflows/runs/:runId/publication` | Create/update a publication and its visibility | Same owner/delegate check; idempotency key required |
| `GET /api/v1/workflows/runs/:runId/publication` | Read the owner's publication state, including private state | Owner/delegate Cloud token with publication-read scope |
| `DELETE /api/v1/workflows/runs/:runId/publication` | Revoke public access and discovery; retain the private audit record | Owner/delegate Cloud token with publication-write scope |
| `GET /api/v1/published-flow-runs/:publicId` | Read the permitted public projection | Anonymous for public/unlisted; otherwise indistinguishable 404 |
| `GET /api/v1/published-flow-runs?cursor=…` | Page through public gallery records | Anonymous; returns public records only |

All owner publication and preview responses require `Cache-Control: no-store`;
principal-dependent data must never enter shared caches.

Example write body:

```json
{
  "visibility": "unlisted",
  "title": "Dependency upgrade with a deterministic gate",
  "projectionDigest": "sha256:<digest from server preview>",
  "expectedRunRevision": "<server-issued revision>"
}
```

The SDK obtains the default preview before sending the write, preserving the
simple `publishFlowRun(runId, {visibility})` call. A richer UI can show that
preview for review. Adding transcripts, source, artifacts, or human-written
annotations is a separate explicit operation with a newly reviewed projection;
the default call never opts into those fields.

The server refuses mismatched digest/revision with 409 rather than publishing
data that changed after preview. Unsupported visibility is 400; missing or
expired authentication is 401; missing scope is 403. Inaccessible run IDs and
publication IDs return 404. Failure to persist the snapshot and publication
record returns an error; it must not return a share URL or an apparent success.

An `Idempotency-Key` binds principal, run ID, and request digest. Retrying that
same request returns the existing publication receipt; reusing the key for a
different request returns 409. SDK retries can be added only once this server
contract exists. No existing Cloud submission idempotency is assumed.

## Token and authorization model

- Reuse Cloud's revocable, expiring, principal-bound API tokens and existing
  run ownership/delegation checks. Possessing a token alone does not grant access
  to another principal's run.
- Introduce narrow **proposed** scopes `workflow:publications:write` and
  `workflow:publications:read`. Publication-write is separate from the existing
  `workflow:invoke:write`; permission to execute does not permit disclosure.
  Preview/create also require the existing run-read permission.
- Never use or embed `rk_live_` workspace keys, Cloud bearer tokens, callback
  secrets, or existing observer tokens in public URLs or records. Publication
  is a persisted snapshot, not a 24-hour live observer session.
- Generate the public ID with at least 128 bits of cryptographic randomness.
  For an unlisted run, possession of the URL grants read access to that limited
  projection. It grants no API write, execution, worker, workspace, or stream
  capabilities. Keep the internal Cloud run ID out of public responses.
- A proposed publication audit record retains principal, internal run ID,
  projection digest, visibility transition, timestamp, and request identity in
  Cloud. It is separate from the kernel's tenant-unaware execution journal.

## Visibility tiers

| Tier | Anonymous run URL | Gallery/search | Intended use |
| --- | --- | --- | --- |
| `private` | None; public reads return 404 | Never | Prepare/revoke a publication |
| `unlisted` | Stable opaque URL | Excluded, with `noindex` | Deliberate link sharing |
| `public` | Same stable opaque URL | Eligible for public discovery | Reviewed example run |

Visibility must be explicit in the SDK call. New records default to private in
storage until snapshot persistence and the requested transition commit. A
private transition/revocation immediately disables origin reads, replay reads,
and discovery. Serve publication and replay through visibility-checking endpoints with
permanent `Cache-Control: no-store`; do not expose a public bucket URL or long-lived signed download that
would bypass revocation. Unlisting removes discovery but leaves the link
readable. If caching is introduced later, cache purge and revalidation must complete
before revocation reports success. A previously downloaded public copy cannot
be recalled; that exception does not include responses held in shared caches.

## Published record

The server derives a versioned, positive-allowlist projection from authenticated
durable evidence. It must never copy an internal run object wholesale and then
try to redact known secrets.

```ts
interface PublishedFlowRun { // proposal, not an SDK export
  schemaVersion: 1;
  publicId: string;
  visibility: 'unlisted' | 'public';
  title: string; // explicit author text; otherwise generic "Flow run"
  publishedAt: string;
  snapshotAt: string;
  projectionDigest: string;
  sourceSpecDigest: string;
  engineVersion: 'v2';
  status: 'completed' | 'failed' | 'cancelled';
  completionReason: string; // closed supported kernel vocabulary, not error text
  steps: Array<{
    ordinal: number; // private step IDs/names are not copied
    type: 'deterministic' | 'llm' | 'agent';
    completionReason: string;
    verification: 'passed' | 'failed' | 'not_recorded';
  }>;
  replay: { state: 'not_published' } | {
    state: 'published';
    url: string; // publication-bound, visibility-checked redacted snapshot
    digest: string;
  };
}
```

Only terminal runs with durable completion reasons are eligible initially.
Missing/corrupt evidence refuses publication. Verification values must come
from recorded verifier facts, not be inferred from a step's successful exit or
an agent's statement. Typed reason values must be validated against the
supported journal version; do not publish arbitrary error strings.

Exclude inputs, environment, commands, stdout/stderr, prompts, transcripts,
diffs, filesystem paths, repository identifiers, credential names, tokens,
principal IDs, workspace IDs, internal run IDs, and raw exception messages by
default. Optional author-supplied titles are length-bounded plain text and
escaped on rendering; never inherit a private flow's name automatically.

Replay starts as `not_published`. Publishing an actual session replay requires
separate explicit selection and preview of a sanitized, immutable session
snapshot, with its own digest and the publication's access checks. A journal
summary is not a session replay. Do not create a replay URL or claim that replay
was published unless that snapshot exists and can be read under these rules.

## Gallery design — no app, site, or route implementation

The gallery's headline is **Deterministic gates + session replay + BYO CLI
harness**. Each entry presents an actual public example run: its explicitly
published title, gate result, terminal outcome, and a replay link only when
replay is published. Harness metadata is excluded until a versioned, sanitized,
explicit-opt-in projection and API are defined; the current schema has none.
The run detail leads with evidence and distinguishes verification from agent
output. Labels describe the observed run rather than promising that every
example or authored verb works in Cloud.

There is one stable publication URL per showcased example run. Public gallery
queries never enumerate private or unlisted records. An empty gallery states
that no examples have been published; it contains no fixture rows, invented
run IDs, authenticated API URLs presented as share links, or synthetic replays.
Examples that exist only as design source are not runnable gallery entries.

Before implementation, an identified Cloud owner must settle storage/migrations,
scope issuance, run-read delegation, journal projection versioning, replay
sanitization, revocation behavior, and retention. The landing page was cancelled
by Khaliq and has no WS-14 acceptance requirement. Before a future gallery
launch, at least one real run must be published, viewed anonymously, excluded
when unlisted, and revoked to 404. These are proposed acceptance requirements, not test results for WS-14.
