// Per-issue implementer flow with real gates.
//
// This is a DESIGN ARTIFACT. It uses primitives that are landing in the
// 2026-09-10 launch wave (`f.llm`, structured value binding, `output`
// schema on agent steps — flows#273/#275). Until those close, treat this
// as target shape rather than a runnable script.
//
// Design intent (against the drive-local class of bugs — flows#271, #284):
// nothing that decides whether code moves toward merge is agent-adjudicated.
// The agents produce structured blockers/reasons; the aggregation gates that
// let a change advance are deterministic steps reading typed JSON outputs.
//
// The PR-open step is an `agent` step declaring `surfaces.external`, not a
// `deterministic` shelling out to `gh pr create`. Gate 6 elects one attempt
// via `effect.record` + confirms via `effect.confirm`; the filename at the
// relayfile mount is the idempotency key so a retry cannot open two PRs.

import { flow, f } from '@relayflows/surface';

interface ImplementerInput {
  /** `AgentWorkforce/flows` or `AgentWorkforce/cloud`. Kept as one string so
   *  the relayfile mount path derivation stays a single interpolation. */
  repo: string;
  /** GitHub issue number the run must close. Journaled with the step, so a
   *  crash-and-resume rehydrates the correct issue. */
  issue: number;
  /** Path to the .md brief the implementation agent reads. Located inside
   *  the run's worktree so the pinned base commit fixes what the agent sees. */
  briefPath: string;
  /** Files the implementation is ALLOWED to touch. Enforced by the scope
   *  gate before any reviewer sees the diff — the exact drive-local defect
   *  #242/#271 exists to catch. */
  declaredFiles: string[];
}

// Structured verdict every review lens returns. Deterministic aggregation
// reads `blocked` — a lens setting `blocked=true` without concrete reasons
// is treated the same as a schema failure and blocks the merge.
const LENS_VERDICT_SCHEMA = {
  type: 'object' as const,
  required: ['blocked', 'reasons'],
  properties: {
    blocked: { type: 'boolean' },
    reasons: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
};

// Hard ceiling on repair iterations. Beyond this the run terminates in
// `needs_human` (RFC-0001 gate 5), not `step_failed` — the outcomes are
// meaningfully different for an operator triaging the drive-cloud queue.
const MAX_REPAIR_ITERATIONS = 3;

export default flow(async (f, input: ImplementerInput) => {

  // 1. DETERMINISTIC SETUP — pinned base worktree, verified fresh state.
  //
  // The base commit is pinned by `output.baseSha` so every downstream step
  // that references the worktree observes the same tree. A crash resume
  // does NOT re-checkout: the runner materializes the same commit from
  // its journal, matching gate-1's covenant.
  const worktree = await f.deterministic({
    id: 'worktree',
    command: `
      set -euo pipefail
      dir=/tmp/impl-${input.issue}
      rm -rf "$dir"
      git worktree add "$dir" origin/main
      cd "$dir"
      printf '{"path":"%s","baseSha":"%s"}\n' "$dir" "$(git rev-parse HEAD)"
    `,
    verification: {
      type: 'json_schema',
      schema: {
        type: 'object',
        required: ['path', 'baseSha'],
        properties: { path: { type: 'string' }, baseSha: { type: 'string' } },
        additionalProperties: false,
      },
    },
  });

  // 2. TYPED PLAN — llm output validated against a schema.
  //
  // The `output` sugar compiles to a `json_schema` verification (per
  // spec.ts:LlmStepSpec). A hallucinated plan that doesn't parse as
  // {files, testFiles, risks} fails the step, doesn't bypass it.
  const plan = await f.llm({
    id: 'plan',
    prompt: `Read ${input.briefPath} and produce an implementation plan.\n` +
            `Include: exactly the files you will touch, the test files you\n` +
            `will add or modify, and the risks worth naming to a reviewer.`,
    output: {
      type: 'object',
      required: ['files', 'testFiles', 'risks'],
      properties: {
        files: { type: 'array', items: { type: 'string' } },
        testFiles: { type: 'array', items: { type: 'string' } },
        risks: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
  });

  // 3-7. REPAIR LOOP — bounded, fresh-context each iteration.
  //
  // Each pass produces an implementation, mechanical scope + verify gates,
  // three independent review lenses, and a deterministic aggregate verdict.
  // A blocked verdict feeds its `reasons` into the next iteration's impl
  // agent as `input.blockers` — same shape as gate 2's `wake_context` per
  // RFC-0001 (flows#251) so a resume observes the same replay input.
  let impl: unknown = null;
  let verdict: { approved: boolean; blockers: string[] } | null = null;
  let iteration = 0;

  while (iteration < MAX_REPAIR_ITERATIONS) {
    iteration += 1;

    // 3. IMPLEMENTATION — declared output schema; blockers from prior verdict.
    impl = await f.agent({
      id: `impl-${iteration}`,
      cli: 'codex',
      instruction:
        `Iteration ${iteration}. Execute the plan against the pinned worktree. ` +
        `Touch ONLY files listed in the plan. If prior blockers are supplied, ` +
        `address them without widening scope. Emit {sha, filesTouched} on success.`,
      input: {
        plan: { step: 'plan' },
        cwd: { step: 'worktree', path: ['path'] },
        blockers: verdict ? { step: `aggregate-${iteration - 1}`, path: ['blockers'] } : [],
      },
      output: {
        type: 'object',
        required: ['sha', 'filesTouched'],
        properties: {
          sha: { type: 'string' },
          filesTouched: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    });

    // 4. SCOPE GATE — deterministic, mechanical, unbypassable.
    //
    // Compares the sorted file list actually touched against the declared
    // allowed set. Runs BEFORE any reviewer sees the diff so a scope
    // violation short-circuits without spending review budget. This is
    // exactly the shape #242/#271 needed and the class fix #284 tracks.
    await f.deterministic({
      id: `scope-${iteration}`,
      command: `./scripts/scope-gate.sh "$WORKTREE" '${JSON.stringify(input.declaredFiles)}'`,
      input: { WORKTREE: { step: 'worktree', path: ['path'] } },
      verification: {
        type: 'json_schema',
        schema: {
          type: 'object',
          required: ['scopeOk'],
          properties: { scopeOk: { const: true } },
        },
      },
    });

    // 5. VERIFY GATE — deterministic: tsc + tests, JSON output, no free-form.
    //
    // Emits vitest's --reporter=json + `tsc --noEmit` exit-status folded
    // into one JSON blob. The verification asserts numFailed === 0 AND
    // tscOk === true. An agent cannot pass this by asserting success —
    // the JSON is produced by the tools themselves.
    const verify = await f.deterministic({
      id: `verify-${iteration}`,
      command: `./scripts/verify.sh "$WORKTREE"`,
      input: { WORKTREE: { step: 'worktree', path: ['path'] } },
      verification: {
        type: 'json_schema',
        schema: {
          type: 'object',
          required: ['numPassed', 'numFailed', 'tscOk'],
          properties: {
            numPassed: { type: 'number' },
            numFailed: { const: 0 },
            tscOk: { const: true },
          },
        },
      },
    });

    // 6. REVIEW SWARM — three independent lenses, parallel.
    //
    // Each lens has:
    //   - a different provider (so a shared model bias cannot quorum),
    //   - a specific angle (correctness / regression-risk / maintainability),
    //   - a `default to blocked=true` instruction (the pattern that catches
    //     plausible-but-wrong; the review-fix-signoff skill's covenant).
    // No lens sees another lens's verdict — the aggregation happens in the
    // deterministic step below, not inside any agent's context.
    const [correctness, regression, maintainability] = await Promise.all([
      f.agent({
        id: `correctness-${iteration}`,
        cli: 'claude',
        instruction:
          `You are the CORRECTNESS lens. Default blocked=true. ` +
          `Approve only if the implementation solves issue #${input.issue} ` +
          `as stated in its brief. Read plan, diff, and tests. Refute where you can. ` +
          `Cite specific lines when blocking.`,
        input: {
          plan: { step: 'plan' },
          impl: { step: `impl-${iteration}` },
          verify: { step: `verify-${iteration}` },
        },
        output: LENS_VERDICT_SCHEMA,
      }),
      f.agent({
        id: `regression-${iteration}`,
        cli: 'codex',
        instruction:
          `You are the REGRESSION lens. Default blocked=true. ` +
          `Find what this change could BREAK that isn't tested. Look at ` +
          `neighboring code, callers, downstream. Cite one concrete example ` +
          `per blocker.`,
        input: {
          plan: { step: 'plan' },
          impl: { step: `impl-${iteration}` },
        },
        output: LENS_VERDICT_SCHEMA,
      }),
      f.agent({
        id: `maintainability-${iteration}`,
        cli: 'claude',
        instruction:
          `You are the MAINTAINABILITY lens. Default blocked=true. ` +
          `Comments correct? Names honest? Dead-code residue from earlier ` +
          `attempts? Any over-abstraction? An identifier lying about what it ` +
          `describes is a blocker.`,
        input: { impl: { step: `impl-${iteration}` } },
        output: LENS_VERDICT_SCHEMA,
      }),
    ]);

    // 7. AGGREGATE — deterministic, not agent-adjudicated.
    //
    // Combines three lens verdicts, the scope gate result, and the verify
    // gate result into one decision. Approve requires ALL five to green.
    // The shell script is trivial (jq over its inputs); keeping it here
    // rather than an agent step makes the approval mechanically auditable —
    // no LLM can rationalize its way past a boolean.
    verdict = await f.deterministic({
      id: `aggregate-${iteration}`,
      command: `./scripts/aggregate-review.sh`,
      input: {
        correctness: { step: `correctness-${iteration}` },
        regression: { step: `regression-${iteration}` },
        maintainability: { step: `maintainability-${iteration}` },
        verify: { step: `verify-${iteration}` },
      },
      verification: {
        type: 'json_schema',
        schema: {
          type: 'object',
          required: ['approved', 'blockers'],
          properties: {
            approved: { type: 'boolean' },
            blockers: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
      },
    });

    if (verdict.approved) break;
  }

  // 8. BOUNDED FAILURE — never a silent stall. If review never converged,
  //    surface `needs_human` with the iteration count and every accumulated
  //    blocker. RFC-0001 gate 5 language, not a bare step_failed.
  if (!verdict || !verdict.approved) {
    return await f.deterministic({
      id: 'report-blocked',
      command:
        `./scripts/report-blocked.sh --issue ${input.issue} ` +
        `--iterations ${iteration} --blockers "$BLOCKERS"`,
      input: { BLOCKERS: { step: `aggregate-${iteration}`, path: ['blockers'] } },
      // The reported outcome should surface as needs_human, not step_failed.
      // The script exits with an inspection-friendly diagnostic and a
      // non-zero code the runner recognizes as gate-5 hand-off.
      verification: {
        type: 'json_schema',
        schema: {
          type: 'object',
          required: ['outcome', 'inspectionUrl'],
          properties: { outcome: { const: 'needs_human' } },
        },
      },
    });
  }

  // 9. PR OPEN — relayfile writeback, not `gh pr create`.
  //
  // Declares `surfaces.external` naming the mount path. The runner elects
  // one attempt via `effect.record`, journals the write, then closes with
  // `effect.confirm` (kernel DAEMON-LIFECYCLE.md gate 6). Filename at the
  // mount is the idempotency key — a retried attempt writes the same
  // filename and the GitHub adapter refuses the duplicate rather than
  // opening a second PR. `gh pr create` carries none of that.
  //
  // The instruction is deliberately mechanical — the agent's job is to
  // format the JSON body from prior step outputs and drop it at the
  // declared path. No creative interpretation.
  return await f.agent({
    id: 'open-pr',
    cli: 'codex',
    instruction:
      `Drop a PR-creation JSON at the relayfile mount path declared in ` +
      `surfaces.external. Filename must be "impl-${input.issue}.json" — ` +
      `the adapter uses it as the idempotency key. Fields required by the ` +
      `adapter: {title, head, base, body, idempotency_key}. Set head to ` +
      `the branch pushed by the impl step (from impl.sha). Body should ` +
      `include the plan's risks section and link to the reviewer verdicts. ` +
      `Emit {prUrl} once the writeback is confirmed by the adapter.`,
    input: {
      impl: { step: `impl-${iteration}` },
      plan: { step: 'plan' },
      correctness: { step: `correctness-${iteration}` },
      regression: { step: `regression-${iteration}` },
      maintainability: { step: `maintainability-${iteration}` },
      issue: input.issue,
    },
    surfaces: {
      external: [
        // Canonical writeback path per relayfile's GitHub adapter. The
        // exact prefix is workspace-dependent; ${RELAYFILE_MOUNT} is the
        // ambient env the runner sets when a mount is attached.
        `github/${input.repo}/pulls/create`,
      ],
    },
    output: {
      type: 'object',
      required: ['prUrl'],
      properties: { prUrl: { type: 'string' } },
      additionalProperties: false,
    },
  });
});
