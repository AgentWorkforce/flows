// Ported from wepost-no/agents tests/review-agent.test.mjs. The pure functions
// are the same; the `ctx`-reading ones take a config object here, and the v4
// harness-retry / exit-code diagnostics tests are gone with the code they
// tested (the kernel owns retries and leases; the journal is the log).
//
//   node --experimental-strip-types --test examples/pr-reviewer/tests/pr-state.test.ts

import assert from "node:assert/strict";
import test from "node:test";

import {
  commentBody,
  commenterLogin,
  HARNESS_RESOURCE_ENV,
  conflictResolveHarnessPrompt,
  harnessOutputTail,
  deriveReviewDecision,
  evaluateMergeOnGreenState,
  isAuthorizedConflictCommander,
  labelNames,
  matchesConflictDirective,
  prReadyStateAllowsHumanReview,
  prReviewStateFromRest,
  prFromInput,
  mergeRefusal,
  approvedCommit,
  protectedPathRefusal,
  testCommand,
  reviewer,
  readPr,
  resolveAuthorLogin,
  reviewHarnessPrompt,
  reviewAuthorAllowlistDecision,
  rollupFromCheckSummary,
  shouldSkipReview,
  shellWord,
} from "../pr-reviewer.flow.ts";
import { getFlowDefinition } from "@relayflows/surface/runtime";

test('reviewAuthorAllowlistDecision lets configured authors through', () => {
  assert.equal(reviewAuthorAllowlistDecision(new Set(['willwashburn']), 'willwashburn'), null);
});

test('reviewAuthorAllowlistDecision skips authors not in the allowlist', () => {
  assert.deepEqual(
    reviewAuthorAllowlistDecision(new Set(['khaliqgant']), 'willwashburn'),
    { reason: 'author @willwashburn is not in REVIEW_AUTHORS' },
  );
});

test('reviewAuthorAllowlistDecision skips unresolved authors when configured', () => {
  assert.deepEqual(
    reviewAuthorAllowlistDecision(new Set(['khaliqgant']), ''),
    { reason: 'REVIEW_AUTHORS is set but the PR author could not be resolved', notify: true },
  );
  assert.deepEqual(
    reviewAuthorAllowlistDecision(new Set(['khaliqgant']), 'unknown'),
    { reason: 'REVIEW_AUTHORS is set but the PR author could not be resolved', notify: true },
  );
});

test('reviewAuthorAllowlistDecision leaves unset allowlists open to everyone', () => {
  assert.equal(reviewAuthorAllowlistDecision(new Set(), 'willwashburn'), null);
  assert.equal(reviewAuthorAllowlistDecision(new Set(), ''), null);
  assert.equal(reviewAuthorAllowlistDecision(new Set(), 'unknown'), null);
});

test('resolveAuthorLogin prefers normalized meta author shapes', () => {
  assert.equal(resolveAuthorLogin({ author: ' WillWashburn ' }, { author: 'fallback' }), 'willwashburn');
  assert.equal(resolveAuthorLogin({ author: { login: ' KhaliqGant ' } }, { author: 'fallback' }), 'khaliqgant');
  assert.equal(resolveAuthorLogin({}, { author: ' FallBack ' }), 'fallback');
});

test('readPr does not treat check-run sender as the PR author', () => {
  assert.deepEqual(readPr({
    check_run: {
      pull_requests: [{
        number: 27,
        html_url: 'https://github.com/AgentWorkforce/agents/pull/27',
        head_sha: 'abc123',
      }],
    },
    repository: { name: 'agents', owner: { login: 'AgentWorkforce' } },
    sender: { login: 'allowed-bot' },
  }), {
    owner: 'AgentWorkforce',
    repo: 'agents',
    number: 27,
    url: 'https://github.com/AgentWorkforce/agents/pull/27',
    author: 'unknown',
    headSha: 'abc123',
  });
});

test('readPr uses the pull request opener as author when present', () => {
  assert.equal(readPr({
    number: 27,
    pull_request: {
      number: 27,
      html_url: 'https://github.com/AgentWorkforce/agents/pull/27',
      user: { login: 'WillWashburn' },
    },
    repository: { name: 'agents', owner: { login: 'AgentWorkforce' } },
    sender: { login: 'reviewer' },
  })?.author, 'WillWashburn');
});

test('readPr falls back to sender login for PR-shaped payloads when opener login is missing', () => {
  assert.equal(readPr({
    number: 27,
    pull_request: {
      number: 27,
      html_url: 'https://github.com/AgentWorkforce/agents/pull/27',
    },
    repository: { name: 'agents', owner: { login: 'AgentWorkforce' } },
    sender: { login: 'KhaliqGant' },
  })?.author, 'KhaliqGant');
});

test('readPr surfaces the draft flag so the draft gate can hold off', () => {
  // The draft flag feeds shouldSkipReview's preemptive draft gate — a held PR
  // must not be auto-reviewed/pushed. Read it off the pull_request payload.
  assert.equal(readPr({
    number: 27,
    pull_request: {
      number: 27,
      html_url: 'https://github.com/AgentWorkforce/agents/pull/27',
      user: { login: 'WillWashburn' },
      draft: true,
    },
    repository: { name: 'agents', owner: { login: 'AgentWorkforce' } },
  })?.draft, true);
  // A non-draft PR carries draft:false (not undefined) so the gate can tell
  // "explicitly ready" from "unknown".
  assert.equal(readPr({
    number: 28,
    pull_request: {
      number: 28,
      html_url: 'https://github.com/AgentWorkforce/agents/pull/28',
      user: { login: 'WillWashburn' },
      draft: false,
    },
    repository: { name: 'agents', owner: { login: 'AgentWorkforce' } },
  })?.draft, false);
});

test('matchesConflictDirective fires only on an explicit fix/resolve-conflicts ask', () => {
  assert.equal(matchesConflictDirective('@relay fix conflicts'), true);
  assert.equal(matchesConflictDirective('hey @relay-bot RESOLVE conflict now'), true);
  assert.equal(matchesConflictDirective('@relay resolve conflicts please'), true);
  // The directive words must be adjacent — filler between them does not fire,
  // so a force-update is never triggered by a loose mention.
  assert.equal(matchesConflictDirective('@relay-bot please RESOLVE the conflict'), false);
  // A passing mention or a plain observation must NOT trigger a force-update.
  assert.equal(matchesConflictDirective('@relay this PR has a conflict'), false);
  assert.equal(matchesConflictDirective('there is a merge conflict here'), false);
  assert.equal(matchesConflictDirective(''), false);
});

test('commentBody / commenterLogin read the issue_comment payload defensively', () => {
  const payload = { comment: { body: '@relay fix conflicts', user: { login: 'KhaliqGant' } } };
  assert.equal(commentBody(payload), '@relay fix conflicts');
  assert.equal(commenterLogin(payload), 'khaliqgant');
  assert.equal(commentBody({}), '');
  assert.equal(commenterLogin({}), '');
});

test('readPr reads a PR from an issue_comment payload when the issue is a pull request', () => {
  const pr = readPr({
    action: 'created',
    issue: {
      number: 77,
      html_url: 'https://github.com/AgentWorkforce/agents/pull/77',
      user: { login: 'WillWashburn' }, // the PR opener — must win as author
      state: 'open',
      pull_request: { url: 'https://api.github.com/.../pulls/77' },
    },
    comment: { body: '@relay fix conflicts', user: { login: 'KhaliqGant' } },
    repository: { name: 'agents', owner: { login: 'AgentWorkforce' } },
    sender: { login: 'KhaliqGant' },
  });
  assert.equal(pr?.number, 77);
  assert.equal(pr?.author, 'WillWashburn');
  assert.equal(pr?.url, 'https://github.com/AgentWorkforce/agents/pull/77');
});

test('readPr ignores an issue_comment on a plain issue (no pull_request marker)', () => {
  assert.equal(readPr({
    action: 'created',
    issue: { number: 5, html_url: 'https://github.com/AgentWorkforce/agents/issues/5' },
    comment: { body: '@relay fix conflicts' },
    repository: { name: 'agents', owner: { login: 'AgentWorkforce' } },
  }), undefined);
});

test('isAuthorizedConflictCommander never takes the order from a bot', () => {
  const pr = { owner: 'AgentWorkforce', repo: 'agents', number: 1, author: 'someone' };
  assert.equal(isAuthorizedConflictCommander({}, 'relay-conflict-autofix[bot]', pr), false);
  assert.equal(isAuthorizedConflictCommander({}, '', pr), false);
});

test('isAuthorizedConflictCommander fails closed to the PR author when no trust lists are configured', () => {
  const pr = { owner: 'AgentWorkforce', repo: 'agents', number: 1, author: 'willwashburn' };
  assert.equal(isAuthorizedConflictCommander({}, 'anyone', pr), false);
  assert.equal(isAuthorizedConflictCommander({}, 'willwashburn', pr), true);
});

test('isAuthorizedConflictCommander gates on APPROVERS/REVIEW_AUTHORS and the PR author', () => {
  const pr = { owner: 'AgentWorkforce', repo: 'agents', number: 1, author: 'WillWashburn' };
  // PR author may always fix their own PR's conflicts even if not on a list.
  assert.equal(isAuthorizedConflictCommander({ approvers: 'khaliqgant' }, 'willwashburn', pr), true);
  // A listed approver qualifies.
  assert.equal(isAuthorizedConflictCommander({ approvers: 'khaliqgant' }, 'khaliqgant', pr), true);
  // A REVIEW_AUTHORS member qualifies too.
  assert.equal(isAuthorizedConflictCommander({ reviewAuthors: 'octocat' }, 'octocat', pr), true);
  // A stranger, with a list configured, does not.
  assert.equal(isAuthorizedConflictCommander({ approvers: 'khaliqgant' }, 'randuser', pr), false);
});

test('conflictResolveHarnessPrompt keeps the no-git boundary and the safety/escape-hatch rules', () => {
  const prompt = conflictResolveHarnessPrompt({ owner: 'AgentWorkforce', repo: 'agents', number: 99 });
  // Reads cloud's merged tree + conflicted-file manifest.
  assert.match(prompt, /\.workforce\/conflicted-files\.txt/);
  assert.match(prompt, /the flow has already merged the base branch into the working tree/);
  // No git in the harness; cloud finalizes + pushes the merge.
  assert.match(prompt, /Do NOT use git or the gh CLI/);
  assert.match(prompt, /The flow finalizes the merge commit and pushes/);
  // Combine both sides; strip every marker.
  assert.match(prompt, /preserves BOTH sides' intent/);
  assert.match(prompt, /leave no <<<<<<<, =======, or >>>>>>> behind/);
  // Same safety guardrails as review.
  assert.match(prompt, /fail-closed state into a\s+fail-open one/);
  assert.match(prompt, /Never weaken or delete a test/);
  assert.match(prompt, /Never touch lifecycle, termination, reaper/);
  // Human-judgment escape hatch → cloud aborts the merge.
  assert.match(prompt, /## Unresolved conflicts/);
  assert.match(prompt, /The flow aborts the\s+merge/);
  // CI-deep verification of the merged tree.
  assert.match(prompt, /verify the merged tree the way CI does/);
});

test('labelNames normalizes github label arrays defensively', () => {
  assert.deepEqual(labelNames([
    { name: ' No-Agent-Relay-Review ' },
    { name: '' },
    { name: 42 },
    null,
    { other: 'ignored' },
  ]), ['no-agent-relay-review']);
  assert.deepEqual(labelNames(undefined), []);
});

test('readPr resolves issue labeled payloads for pull requests in any AgentWorkforce repo', () => {
  assert.deepEqual(readPr({
    action: 'labeled',
    label: { name: 'merge-on-green' },
    issue: {
      number: 158,
      html_url: 'https://github.com/AgentWorkforce/relayfile-adapters/issues/158',
      pull_request: {},
      labels: [{ name: 'merge-on-green' }],
    },
    repository: { name: 'relayfile-adapters', owner: { login: 'AgentWorkforce' } },
  }), {
    owner: 'AgentWorkforce',
    repo: 'relayfile-adapters',
    number: 158,
    url: 'https://github.com/AgentWorkforce/relayfile-adapters/issues/158',
    author: 'unknown',
    labels: [{ name: 'merge-on-green' }],
  });
});

test('evaluateMergeOnGreenState requires label, green checks, and requested bot approvals', () => {
  const base = {
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    labels: [{ name: 'merge-on-green' }],
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
    reviewRequests: [
      { requestedReviewer: { login: 'coderabbitai[bot]', type: 'Bot' } },
    ],
    latestReviews: [
      { author: { login: 'coderabbitai[bot]', type: 'Bot' }, state: 'APPROVED', submittedAt: '2026-06-10T00:00:00Z' },
    ],
  };

  assert.deepEqual(evaluateMergeOnGreenState(base), { outcome: 'ready', reasons: [] });

  assert.equal(evaluateMergeOnGreenState({
    ...base,
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'unit', status: 'IN_PROGRESS', conclusion: null },
    ],
  }).outcome, 'pending');

  assert.deepEqual(evaluateMergeOnGreenState({
    ...base,
    latestReviews: [],
  }), {
    outcome: 'pending',
    reasons: ['bot @coderabbitai[bot] has not approved yet'],
  });

  assert.equal(evaluateMergeOnGreenState({
    ...base,
    latestReviews: [
      { author: { login: 'gemini-code-assist[bot]', type: 'Bot' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-06-10T00:00:00Z' },
    ],
  }).outcome, 'blocked');
});

test('rollupFromCheckSummary maps the adapter check summary to gate-ready rollups', () => {
  // No checks ingested yet (missing / total 0) → empty rollup. The gates then
  // fall through to mergeStateStatus (which the VFS path never reports CLEAN),
  // so the PR HOLDS instead of going green on absent CI.
  assert.deepEqual(rollupFromCheckSummary(undefined), []);
  assert.deepEqual(rollupFromCheckSummary({ total: 0, passed: 0, failed: 0, pending: 0 }), []);

  // All complete and passing → one SUCCESS entry the evaluators read as green.
  const green = rollupFromCheckSummary({ total: 3, passed: 3, failed: 0, pending: 0 });
  assert.equal(evaluateMergeOnGreenState({
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE',
    labels: [{ name: 'merge-on-green' }], statusCheckRollup: green,
  }).outcome, 'ready');

  // A pending check → IN_PROGRESS → the merge-on-green gate stays pending.
  const pending = rollupFromCheckSummary({ total: 2, passed: 1, failed: 0, pending: 1 });
  assert.equal(evaluateMergeOnGreenState({
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE',
    labels: [{ name: 'merge-on-green' }], statusCheckRollup: pending,
  }).outcome, 'pending');

  // A failing check → FAILURE → blocked.
  const failing = rollupFromCheckSummary({ total: 2, passed: 1, failed: 1, pending: 0 });
  assert.equal(evaluateMergeOnGreenState({
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE',
    labels: [{ name: 'merge-on-green' }], statusCheckRollup: failing,
  }).outcome, 'blocked');

  // Green checks also satisfy the human-review ready gate.
  assert.equal(prReadyStateAllowsHumanReview({
    state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: green,
  }), true);

  // `total` missing but component counts present → derive total from the counts
  // so a failing check still blocks (not treated as "no checks reported").
  assert.equal(evaluateMergeOnGreenState({
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', labels: [{ name: 'merge-on-green' }],
    statusCheckRollup: rollupFromCheckSummary({ failed: 1, pending: 0, passed: 2 }),
  }).outcome, 'blocked');
});

test('deriveReviewDecision flags CHANGES_REQUESTED from the latest review per author', () => {
  // No reviews → undefined (not blocking).
  assert.equal(deriveReviewDecision([]), undefined);

  // A later APPROVED supersedes an earlier CHANGES_REQUESTED from the same author.
  assert.equal(deriveReviewDecision([
    { author: { login: 'coderabbitai[bot]' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-06-10T00:00:00Z' },
    { author: { login: 'coderabbitai[bot]' }, state: 'APPROVED', submitted_at: '2026-06-11T00:00:00Z' },
  ]), undefined);

  // An outstanding CHANGES_REQUESTED (the author's latest) blocks.
  assert.equal(deriveReviewDecision([
    { author: { login: 'willwashburn' }, state: 'APPROVED', submitted_at: '2026-06-10T00:00:00Z' },
    { author: { login: 'coderabbitai[bot]' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-06-11T00:00:00Z' },
  ]), 'CHANGES_REQUESTED');
});

test('reviewHarnessPrompt forbids git except the explicit restore-only carve-out', () => {
  const prompt = reviewHarnessPrompt({ owner: 'AgentWorkforce', repo: 'agents', number: 47 });
  assert.match(prompt, /Don't use git or the gh CLI/);
  // "git restore <file>" is deliberately permitted for discarding unverified
  // edits (agents#47 review): rewriting a file back from memory is error-prone,
  // a restore from HEAD is not. It must be framed as the exception...
  assert.match(prompt, /git restore <file>.*exception to the no-git rule/);
  // ...and no destructive/state-mutating git verb may creep in.
  assert.doesNotMatch(prompt, /\bgit\s+(checkout|reset|clean|commit|push|add|fetch|pull|rebase|merge|stash)\b/);
});

test('reviewHarnessPrompt keeps fixes within the PR scope and verifies CI-deep', () => {
  const prompt = reviewHarnessPrompt({ owner: 'AgentWorkforce', repo: 'agents', number: 162 });
  // Scope discipline: out-of-scope reviewer suggestions become advisory notes,
  // not edits folded into this PR (the dropbox/linear scope-creep that broke an
  // unrelated build in agents#162's downstream relayfile-adapters PR).
  assert.match(prompt, /Stay within this PR's purpose/);
  assert.match(prompt, /use \.workforce\/context\.json for available PR\s+metadata/);
  assert.match(prompt, /record it as an advisory note under a "## Advisory Notes" heading in your review and leave the code unchanged/);
  // Verification must be CI-deep (full build/test), not just the touched file,
  // and must regenerate generated/committed artifacts the edit feeds.
  assert.match(prompt, /verify it the way CI does/);
  assert.match(prompt, /canonical build and test command end to end/);
  assert.match(prompt, /regenerate that file with the repo's own generator/);
  assert.match(prompt, /the working tree must pass the full command with your edits in place/);
  // Anti-hollow guard: don't make a check pass by gutting the test.
  assert.match(prompt, /Never make a check pass by weakening the test/);
  assert.match(prompt, /worse than no test/);
  assert.match(prompt, /only change a test's EXPECTATION when the test encoded the OLD/);
});

test('reviewHarnessPrompt limits auto-edits to mechanical changes', () => {
  const prompt = reviewHarnessPrompt({ owner: 'AgentWorkforce', repo: 'agents', number: 266 });
  assert.match(prompt, /Auto-edit only lint, formatting, spelling, typo, import-order, or other mechanical non-semantic changes/);
  assert.match(prompt, /Do not auto-edit semantic or safety-critical logic/);
  assert.match(prompt, /leave a clear suggestion or review comment instead of changing files/);
  assert.match(prompt, /PR already has a human review or approval/);
  assert.match(prompt, /suggestion\/comment-only/);
});

test('reviewHarnessPrompt forbids safety-default and lifecycle edits', () => {
  const prompt = reviewHarnessPrompt({ owner: 'AgentWorkforce', repo: 'factory-sdk', number: 264 });
  assert.match(prompt, /Never change semantic or safety defaults/);
  assert.match(prompt, /fail-closed states into fail-open states/);
  assert.match(prompt, /"timeout", "pending", throw, or undefined becoming "acked", true, \{\}/);
  assert.match(prompt, /swap truthiness checks for presence checks/);
  assert.match(prompt, /guard default values/);
  assert.match(prompt, /Never touch lifecycle, termination, reaper, in-flight, dispatch, broker ownership, or process-cleanup code/);
});

test('reviewHarnessPrompt forbids self-justifying test edits', () => {
  const prompt = reviewHarnessPrompt({ owner: 'AgentWorkforce', repo: 'agents', number: 243 });
  assert.match(prompt, /Never add or modify tests to make your own change pass/);
  assert.match(prompt, /If a change needs a new or updated test, that is a\s+human decision/);
  assert.match(prompt, /describe the needed test in your review and leave the working tree unchanged/);
});

test('reviewHarnessPrompt only allows READY after checks complete, pass, and the PR is mergeable', () => {
  const prompt = reviewHarnessPrompt({ owner: 'AgentWorkforce', repo: 'agents', number: 100 });
  assert.match(prompt, /every required CI check has completed/);
  assert.match(prompt, /none are pending\s+or in-progress/);
  assert.match(prompt, /all are passing/);
  assert.match(prompt, /GitHub reports it as mergeable/);
  assert.match(prompt, /If any check is still pending, in-progress, or failed, or if the PR\s+has merge conflicts, do NOT print READY/);
  assert.doesNotMatch(prompt, /there are no failing checks left/);
});

test('prReadyStateAllowsHumanReview downgrades READY while a check is pending', () => {
  assert.equal(prReadyStateAllowsHumanReview({
    mergeable: 'MERGEABLE',
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'StatusContext', context: 'deploy-preview', state: 'PENDING' },
    ],
  }), false);
});

test('prReadyStateAllowsHumanReview requires mergeable PRs with only completed passing checks', () => {
  assert.equal(prReadyStateAllowsHumanReview({
    mergeable: 'MERGEABLE',
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'StatusContext', context: 'lint', state: 'NEUTRAL' },
    ],
  }), true);

  assert.equal(prReadyStateAllowsHumanReview({
    mergeable: 'CONFLICTING',
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
  }), false);
});

test('prReadyStateAllowsHumanReview never reports a merged or closed PR ready', () => {
  const passingChecks = [{ __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  assert.equal(prReadyStateAllowsHumanReview({
    state: 'MERGED', mergeable: 'MERGEABLE', statusCheckRollup: passingChecks,
  }), false);
  assert.equal(prReadyStateAllowsHumanReview({
    state: 'CLOSED', mergeable: 'MERGEABLE', statusCheckRollup: passingChecks,
  }), false);
  // An explicit OPEN state still passes when everything else is green.
  assert.equal(prReadyStateAllowsHumanReview({
    state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: passingChecks,
  }), true);
});

test('prReadyStateAllowsHumanReview treats an empty (not-yet-registered) check rollup as not ready', () => {
  // Empty rollup + not CLEAN = checks queued but not yet registered → pending.
  assert.equal(prReadyStateAllowsHumanReview({
    state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', statusCheckRollup: [],
  }), false);
  assert.equal(prReadyStateAllowsHumanReview({
    state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'UNKNOWN',
  }), false);
  // No mergeStateStatus at all is also not-ready (can't confirm nothing's pending).
  assert.equal(prReadyStateAllowsHumanReview({
    state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [],
  }), false);
});

test('prReadyStateAllowsHumanReview allows a no-CI repo (empty rollup) only when GitHub reports CLEAN', () => {
  assert.equal(prReadyStateAllowsHumanReview({
    state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [],
  }), true);
});

test('prReadyStateAllowsHumanReview treats skipped checks as non-blocking', () => {
  assert.equal(prReadyStateAllowsHumanReview({
    state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [
      { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'e2e-conditional', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'StatusContext', context: 'optional-gate', state: 'SKIPPED' },
    ],
  }), true);
});

test('prReadyStateAllowsHumanReview holds back drafts and changes-requested PRs', () => {
  const passingChecks = [{ __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  assert.equal(prReadyStateAllowsHumanReview({
    state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'DRAFT', statusCheckRollup: passingChecks,
  }), false);
  assert.equal(prReadyStateAllowsHumanReview({
    state: 'OPEN', mergeable: 'MERGEABLE', reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: passingChecks,
  }), false);
});

test('reviewHarnessPrompt requires accounting for each bot/reviewer comment with a location', () => {
  const prompt = reviewHarnessPrompt({ owner: 'AgentWorkforce', repo: 'agents', number: 7 });
  assert.match(prompt, /## Addressed comments/);
  assert.match(prompt, /file:line where you/);
  assert.match(prompt, /do not say a comment\s+was addressed without pointing to the fix/);
});


test('reviewHarnessPrompt tells the harness to run build/test serially', () => {
  const prompt = reviewHarnessPrompt({ owner: 'wepost-no', repo: 'wepost-saga', number: 5020 });
  assert.match(prompt, /memory-constrained, so run those steps SERIALLY/);
  assert.match(prompt, /do not raise worker\/concurrency counts/);
  assert.match(prompt, /Run the repo's canonical build and test command end to end/);
});

test('harnessOutputTail keeps the END of the output and drops empties', () => {
  // An OOM stack is the LAST thing written, so head-truncation would discard
  // exactly the evidence this exists to capture.
  assert.equal(harnessOutputTail('abcdef', 3), 'def');
  assert.equal(harnessOutputTail('short'), 'short');
  assert.equal(harnessOutputTail('   '), undefined);
  assert.equal(harnessOutputTail(undefined), undefined);
});


// ── added for the v2 port ───────────────────────────────────────────────────

test("shouldSkipReview applies the four gates in order and returns null to proceed", () => {
  const pr = { owner: "o", repo: "r", number: 1, url: "u", author: "octocat" };
  assert.deepEqual(shouldSkipReview({ state: "closed" }, pr, {}), { reason: "PR is already merged/closed" });
  assert.deepEqual(shouldSkipReview({ merged: true, state: "open" }, pr, {}), { reason: "PR is already merged/closed" });
  assert.deepEqual(shouldSkipReview({ state: "open", draft: true }, pr, {}), { reason: "PR is a draft" });
  assert.deepEqual(shouldSkipReview({ state: "open", labels: [{ name: "No-Agent-Relay-Review" }] }, pr, {}),
    { reason: 'PR carries the "no-agent-relay-review" label' });
  assert.deepEqual(shouldSkipReview({ state: "open", labels: [{ name: "hold" }] }, pr, { skipLabels: "hold,wip" }),
    { reason: 'PR carries the "hold" label' });
  assert.deepEqual(shouldSkipReview({ state: "open", user: { login: "Octocat" } }, pr, { reviewAuthors: "someone" }),
    { reason: "author @octocat is not in REVIEW_AUTHORS" });
  assert.equal(shouldSkipReview({ state: "open", user: { login: "Octocat" } }, pr, { reviewAuthors: "octocat" }), null);
  assert.equal(shouldSkipReview({ state: "open" }, pr, {}), null);
});

test("resolveAuthorLogin reads REST's user.login when meta.author is absent", () => {
  const pr = { owner: "o", repo: "r", number: 1, url: "u", author: "fallback" };
  assert.equal(resolveAuthorLogin({ user: { login: " Octocat " } }, pr), "octocat");
  assert.equal(resolveAuthorLogin({}, pr), "fallback");
});

test("prReviewStateFromRest maps a REST pull, check-runs and reviews onto the gate state", () => {
  const state = prReviewStateFromRest(
    { state: "open", draft: false, mergeable: true, mergeable_state: "clean", head: { sha: "abc" }, labels: [{ name: "x" }] },
    { check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] },
    [{ state: "APPROVED", user: { login: "human" }, submitted_at: "2026-09-17T00:00:00Z" }],
  );
  assert.equal(state.mergeable, "MERGEABLE");
  assert.equal(state.mergeStateStatus, "CLEAN");
  assert.equal(state.headRefOid, "abc");
  assert.equal(state.reviewDecision, undefined);
  assert.equal(prReadyStateAllowsHumanReview(state), true);
  // GitHub has not computed mergeability yet: not ready, never guessed.
  const pending = prReviewStateFromRest({ state: "open", mergeable: null }, { check_runs: [] }, []);
  assert.equal(pending.mergeable, "UNKNOWN");
  assert.equal(prReadyStateAllowsHumanReview(pending), false);
  // A conflicting PR is CONFLICTING for the merge-on-green gate.
  assert.equal(prReviewStateFromRest({ state: "open", mergeable: false }, undefined, []).mergeable, "CONFLICTING");
  // A draft shows as DRAFT even when REST reports a mergeable_state.
  assert.equal(prReviewStateFromRest({ state: "open", draft: true, mergeable_state: "clean" }, undefined, []).mergeStateStatus, "DRAFT");
});

test("prFromInput takes owner/repo/number, or a PR-shaped event, and refuses shell-unsafe coordinates", () => {
  assert.deepEqual(prFromInput({ owner: "o", repo: "r", number: 3, approvers: "" }),
    { owner: "o", repo: "r", number: 3, url: "https://github.com/o/r/pull/3", author: "unknown" });
  const fromEvent = prFromInput({ owner: "", repo: "", number: Number.NaN, approvers: "", event: {
    pull_request: { number: 9, user: { login: "opener" }, head: { sha: "h" } },
    repository: { name: "r", owner: { login: "o" } },
  } });
  assert.equal(fromEvent.number, 9);
  assert.equal(fromEvent.author, "opener");
  assert.equal(fromEvent.headSha, "h");
  assert.throws(() => prFromInput({ owner: "o;rm -rf", repo: "r", number: 1, approvers: "" }), /owner, repo and an integer number/);
  assert.throws(() => prFromInput({ owner: "o", repo: "r", number: 1.5, approvers: "" }), /integer number/);
});

test("shellWord quotes one word, including embedded quotes", () => {
  assert.equal(shellWord("plain"), "'plain'");
  assert.equal(shellWord("it's"), "'it'\\''s'");
});

test("HARNESS_RESOURCE_ENV holds the test run to one worker under the sandbox heap cap", () => {
  assert.equal(HARNESS_RESOURCE_ENV.VITEST_MAX_THREADS, "1");
  assert.equal(HARNESS_RESOURCE_ENV.JEST_MAX_WORKERS, "1");
  const heapMib = Number(/--max-old-space-size=(\d+)/.exec(HARNESS_RESOURCE_ENV.NODE_OPTIONS ?? "")?.[1]);
  assert.ok(heapMib <= 8192 - 2048);
});

test("prFromInput refuses an event that names a different PR than the configured one", () => {
  const event = { pull_request: { number: 9, user: { login: "opener" } }, repository: { name: "other", owner: { login: "o" } } };
  assert.throws(() => prFromInput({ owner: "o", repo: "r", number: 9, approvers: "", event }), /names o\/other#9, not the configured o\/r#9/);
  assert.throws(() => prFromInput({ owner: "o", repo: "r", number: 3, approvers: "", event: { ...event, repository: { name: "r", owner: { login: "o" } } } }), /#9, not the configured o\/r#3/);
  // Agreeing coordinates enrich the PR with the payload's author.
  assert.equal(prFromInput({ owner: "O", repo: "R", number: 9, approvers: "", event: { ...event, repository: { name: "r", owner: { login: "o" } } } }).author, "opener");
});

test("mergeRefusal only lets an approval merge the approved, green, mergeable head", () => {
  const pr = { owner: "o", repo: "r", number: 1, url: "u", author: "a" };
  const green = prReviewStateFromRest({ state: "open", mergeable: true, mergeable_state: "clean", head: { sha: "abc" } },
    { check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }, []);
  assert.equal(mergeRefusal(green, pr, "abc"), undefined);
  assert.equal(pr.headSha, "abc");
  assert.match(mergeRefusal(green, pr, "def") ?? "", /approval was for def, but the head is now abc/);
  assert.match(mergeRefusal({ ...green, headRefOid: undefined }, pr, undefined) ?? "", /head SHA could not be read/);
  const red = prReviewStateFromRest({ state: "open", mergeable: true, mergeable_state: "clean", head: { sha: "abc" } },
    { check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] }, []);
  assert.match(mergeRefusal(red, pr, "abc") ?? "", /check=ci/);
  // An approval without a commit id merges only when the head is green (no stale check possible).
  assert.equal(mergeRefusal(green, pr, undefined), undefined);
  assert.equal(approvedCommit({ review: { commit_id: "0123abc" } }), "0123abc");
  assert.equal(approvedCommit({ review: { commit_id: "not a sha" } }), undefined);
});

test("commit statuses count toward READY alongside check runs", () => {
  const meta = { state: "open", mergeable: true, mergeable_state: "clean", head: { sha: "abc" } };
  const checks = { check_runs: [{ name: "unit", status: "completed", conclusion: "success" }] };
  assert.equal(prReadyStateAllowsHumanReview(prReviewStateFromRest(meta, checks, [], { statuses: [] })), true);
  const pendingPreview = { statuses: [{ context: "deploy-preview", state: "pending" }] };
  assert.equal(prReadyStateAllowsHumanReview(prReviewStateFromRest(meta, checks, [], pendingPreview)), false);
  const failedPreview = { statuses: [{ context: "deploy-preview", state: "failure" }] };
  assert.equal(prReadyStateAllowsHumanReview(prReviewStateFromRest(meta, checks, [], failedPreview)), false);
  assert.equal(prReadyStateAllowsHumanReview(prReviewStateFromRest(meta, checks, [], { statuses: [{ context: "x", state: "success" }] })), true);
});

test("protectedPathRefusal names the first human-owned path and lets ordinary sources through", () => {
  assert.equal(protectedPathRefusal(["src/a.ts", "README.md"]), undefined);
  for (const path of ["package.json", "pkg/package.json", "package-lock.json", "yarn.lock", ".github/workflows/ci.yml",
    "tests/a.test.ts", "src/__tests__/b.ts", "src/c.spec.tsx", "vitest.config.ts", "tsconfig.json", "Cargo.toml", "foo_test.go", "Makefile"]) {
    assert.match(protectedPathRefusal(["src/ok.ts", path]) ?? "", new RegExp(`touched ${path.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`), path);
  }
});

test("testCommand is pinned from input, defaults to npm test, and must be one line", () => {
  assert.equal(testCommand({}), "npm test");
  assert.equal(testCommand({ testCommand: " cargo test --locked " }), "cargo test --locked");
  assert.throws(() => testCommand({ testCommand: "npm test\nrm -rf /" }), /single shell line/);
});

test("the exported handle carries the three PR trigger handlers", () => {
  const definition = getFlowDefinition(reviewer);
  assert.equal(definition.name, "pr-reviewer");
  assert.equal(definition.handlers.length, 3);
});
