# Relayflows landing rewrite

Ready-to-apply copy for the existing landing page. Deployment target is not yet
identified. This file is not a new app, site, or route, and no deployment is
claimed. The opening positions the requested triple together; it does not lead
with durable execution or generic orchestration.

## Hero

Eyebrow: **Relayflows**

Headline: **Deterministic gates. Session replay. Your CLI harness.**

Keep the coding agents you already use. Give their work a check it has to pass
and a recorded session you can review.

Primary action: **Write your first flow** → the existing getting-started guide.

Secondary action: **Read the source** → `https://github.com/AgentWorkforce/flows`.

## The three capabilities

### Set the gate before the work starts

Declare what passing means: a command succeeds, output contains the required
result, or structured output satisfies its schema. The check decides whether
the step can advance. The agent does not get to grade its own work.

### Replay the session behind the result

With session recording enabled, review the agent's work alongside the gate's
outcome. Trace the decisions and tool results that led to a change. A passing
check tells you what passed; the recorded session helps explain how it got
there.

### Bring your CLI harness

Use your authenticated coding-agent CLI. Keep the harness your team already
knows, and put explicit steps and verification around its work. The flow
defines the task and the checks; the harness supplies the agent's tools.

## The workflow

**Define the check → Run the agent → Verify the result → Review the session.**

Start with one small task. Add the deterministic check that makes its result
useful. Record the session when you need a reviewable account of the work.
Keep the agent's output, the verification outcome, and the recorded session
distinct so a reviewer can assess each.

## Placement and availability

Start locally with TypeScript authoring and your own CLI harness. The Cloud SDK
preview submits declarative YAML and JSON to hosted execution and lets you
observe the run without starting a local worker node.

**Hosted TypeScript flows are not supported yet.** See the Cloud SDK guide for
the supported input formats and deployment prerequisites.

Action: **Read the Cloud SDK guide** → the existing documentation route for
`docs/CLOUD.md`, once the landing owner identifies that route. Do not publish a
dead or guessed link.

## Closing action

**Give one agent task a check you can trust.**

Write your first flow. Keep your CLI. Review the evidence.

Action: **Get started** → the existing getting-started guide.

## Publication notes for the landing owner

- Apply this copy to the existing landing surface after its repository/path is
  identified. Preserve its design system, navigation, and working links.
- Do not create a standalone app, gallery route, or publication API for WS-14.
- Do not add a public-run/gallery CTA until that separate design has an owner,
  an implementation, and at least one real anonymously readable publication.
- The Cloud SDK code is a release candidate in flows PR #246. The preview copy
  must not imply that the published npm package already contains it.
- Session replay means inspection of a recorded agent session. It does not mean
  deterministic re-execution of authored TypeScript or a promise that every
  hosted run has a publicly shareable replay.
- Keep claims about timing, successful hosted proof, and blanket example
  compatibility off the page. WS-14's live proof is BLOCKED-ON-CREDENTIAL:
  `Authenticated Cloud-base-path read HTTP: 401`.
