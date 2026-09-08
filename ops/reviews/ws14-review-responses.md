# PR 246 review dispositions

Landing remains cancelled; publication/gallery remains design-only under Khaliq’s ruling.

## Thread 1

https://github.com/AgentWorkforce/flows/pull/246#discussion_r3961238596

Scope disposition: Khaliq explicitly directed this lane to implement declarative submission against the existing Cloud backend. That endpoint accepts workflow/fileType/relayflowVersion and has no sealed-flow-bundle registration/admission contract. Implementing or inventing that backend is outside this ruling. docs/CLOUD.md now explicitly states RFC decision #14 is not delivered or claimed complete; specHash is local correlation, not server attestation. No existing bundle mechanism is bypassed or replaced. The endpoint remains the existing v2 route.

## Thread 2

https://github.com/AgentWorkforce/flows/pull/246#discussion_r3961238605

Fixed in d1ef3ae: an interrupted POST before a receipt reports admission_unknown and explicitly warns that Cloud may have admitted the request and not to resubmit blindly. After receipt, interruption reports observation_aborted and retains runId. Separate regression cases cover both phases and assert one POST.

## Thread 3

https://github.com/AgentWorkforce/flows/pull/246#discussion_r3961238607

Fixed in d1ef3ae: safe GET observation retries known transient transport failures and HTTP 408/429/500/502/503/504 with exponential backoff capped at 30 seconds. Authorization, invalid responses, TLS/redirect failures, and caller abort are not retried. POST still has no application retry. Tests cover timeout, response-body timeout, connection reset, 503/429, permanent errors, and abort during backoff.

## Thread 4

https://github.com/AgentWorkforce/flows/pull/246#discussion_r3961238615

Fixed in d1ef3ae: pre-admission HTTP 401/403 returns exit 2; observation failures after receipt return 1 with runId. Added both credential-refusal regression cases and documented the distinction.

## Thread 5

https://github.com/AgentWorkforce/flows/pull/246#discussion_r3961238619

Corrected in d1ef3ae to say no pre-existing tests, gates, or timeout limits changed. The PR adds cloud regression tests; the prior broader wording was inaccurate.

## Thread 6

https://github.com/AgentWorkforce/flows/pull/246#discussion_r3961238625

Removed the unsupported three-review coverage/signoff claim from the committed description and PR body. Only captured validation is cited. No local-review signoff is claimed.

## Thread 7

https://github.com/AgentWorkforce/flows/pull/246#discussion_r3961331122

Scope disposition: Khaliq explicitly directed this lane to implement declarative submission against the existing Cloud backend. That endpoint accepts workflow/fileType/relayflowVersion and has no sealed-flow-bundle registration/admission contract. Implementing or inventing that backend is outside this ruling. docs/CLOUD.md now explicitly states RFC decision #14 is not delivered or claimed complete; specHash is local correlation, not server attestation. No existing bundle mechanism is bypassed or replaced. The endpoint remains the existing v2 route.

## Thread 8

https://github.com/AgentWorkforce/flows/pull/246#discussion_r3961331128

Fixed in d1ef3ae: an interrupted POST before a receipt reports admission_unknown and explicitly warns that Cloud may have admitted the request and not to resubmit blindly. After receipt, interruption reports observation_aborted and retains runId. Separate regression cases cover both phases and assert one POST.

## Thread 9

https://github.com/AgentWorkforce/flows/pull/246#discussion_r3961331137

Fixed in d1ef3ae: unreadable files, malformed YAML, and invalid declarative specs produce typed invalid_input and exit 2 before HTTP. Tests cover all three and assert no fetch.

## Thread 10

https://github.com/AgentWorkforce/flows/pull/246#discussion_r3961331142

The earlier red transcript is preserved, not presented as green. The 85/85 rerun was in the separate committed ops/runtime-evidence/ws14-wrapper-baseline.txt (CLI 63/63 at both f0a3b3b and WS-14), which the earlier relative links made difficult to find. Those links are corrected. The new review-fix transcript captures another baseline/current comparison. The old failure cause is unconfirmed; I do not claim it is a proven baseline defect or that the old failed run passed. The wrapper test, check.ts, and worker-cli.ts are unchanged against f0a3b3b.

## Thread 11

https://github.com/AgentWorkforce/flows/pull/246#discussion_r3961331148

Fixed in d1ef3ae: safe GET observation retries known transient transport failures and HTTP 408/429/500/502/503/504 with exponential backoff capped at 30 seconds. Authorization, invalid responses, TLS/redirect failures, and caller abort are not retried. POST still has no application retry. Tests cover timeout, response-body timeout, connection reset, 503/429, permanent errors, and abort during backoff.

## Thread 12

https://github.com/AgentWorkforce/flows/pull/246#discussion_r3961331154

Fixed in d1ef3ae: acceptance and API URL use separate CliIo.stdout calls. Regression coverage compares all three output lines, including validated terminal completionReason.

## Thread 13

https://github.com/AgentWorkforce/flows/pull/246#discussion_r3961331165

Fixed code and documentation in d1ef3ae: server HTTP 401/403 is exit 2 before admission, exit 1 with runId during observation. Local configuration/input/format refusals are exit 2.

## Thread 14

https://github.com/AgentWorkforce/flows/pull/246#discussion_r3961331170

Removed the unused Date.now spy and renamed the test to state what it exercises: polling running records until a validated terminal reason arrives. No simulated-hours execution claim remains. SDK no-overall-deadline behavior is documented as implementation behavior, not a live hours-long proof.

## Thread 15

https://github.com/AgentWorkforce/flows/pull/246#discussion_r3961331174

Corrected in d1ef3ae to say no pre-existing tests, gates, or timeout limits changed. The PR adds cloud regression tests; the prior broader wording was inaccurate.

## Thread 16

https://github.com/AgentWorkforce/flows/pull/246#discussion_r3961343634

Design-only clarification in d1ef3ae: all owner publication and preview responses require Cache-Control: no-store; principal-dependent responses must not enter shared caches. No publication backend was built.

## Thread 17

https://github.com/AgentWorkforce/flows/pull/246#discussion_r3961343647

Design-only clarification in d1ef3ae: permanent no-store for visibility-checked publication/replay responses. Any future caching requires purge/revalidation to complete before successful revocation, and shared caches are explicitly outside the downloaded-copy exception.

## Thread 18

https://github.com/AgentWorkforce/flows/pull/246#discussion_r3961343662

Removed the gallery promise of published harness metadata. The design now explicitly excludes it until a versioned sanitized opt-in projection/API exists. PublishedFlowRun stays consistent; no gallery or API implementation was added.

## Thread 19

https://github.com/AgentWorkforce/flows/pull/246#discussion_r3961343672

Fixed evidence links in the committed file to ../runtime-evidence/. The live PR body uses absolute commit links so both render contexts work.

## Thread 20

https://github.com/AgentWorkforce/flows/pull/246#discussion_r3961343693

Fixed in d1ef3ae: HTTPS is mandatory even for loopback; HTTP localhost/127.0.0.1/[::1] refusals are tested before fetch. Unit tests use mocked HTTPS fetch. The packaged artifact proof now serves real local HTTPS using a temporary certificate explicitly trusted through NODE_EXTRA_CA_CERTS; TLS verification remains enabled.

## Review-swarm dispositions

Structure: terminal observation now validates the existing run completion vocabulary and status consistency, exposes completionReason, and refuses absent protocol evidence. Cloud can record provisioning failure/cancellation without a journal report; these produce invalid_response rather than a fabricated completion. Step-level evidence is not supplied by this endpoint and is not synthesized. Cloud arguments are parsed once in cli.ts and dispatch a parsed command to presentation-only runCloudCli.

Maintainability: the docs now separate HTTP request, observation, and backend execution deadlines; describe precise exit-code/refusal semantics; qualify no application-level POST retry; state the spec hash is only local correlation; document workspaceId, strict TLS, GET retry/backoff, and the backend bundle limitation. The test name no longer implies live Cloud integration. Transport/redirect errors are typed and sanitized.

Findings not adopted: credential validation already occurs as the first statement of runInCloud, before file reads/compilation; duplicating it in argv parsing would move SDK logic into the CLI. Fetch does not execute HTML meta-refresh or JavaScript, so these are not redirect bypasses for this client. The existing compiler remains authoritative for both validated dialects; this lane introduces no new dialect discriminator. HTTP 404 remains a permanent observation refusal because Cloud deliberately returns it for inaccessible runs; no documented eventual-consistency contract justifies retrying it. No overall observation timeout is added: minutes/hours-long runs were an explicit requirement, and callers can abort observation. The package proof asserts the route, authorization header, v2/fileType fields, submitted workflow content, receipt, and request count against a local HTTPS server; it never claims live hosted conformance.

The old failed and later passing wrapper captures are retained separately. Neither baseline nor current source reproduces that earlier assertion in the new capture. The old failure cause remains unconfirmed, not labeled as a proven baseline defect. Literal commands/output for this revision are in ../runtime-evidence/ws14-review-fixes.txt.
