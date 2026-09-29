import { flow } from '@relayflows/surface';
import { modelNameError } from '../../src/model-name.js';
import {
  analyzeFindings, checksCommand, failedRunId, MAX_REPAIR_ITERATIONS,
  parseChecks, parseInput, parsePrNumber, quote, type Finding,
} from './close-pr-state.ts';

type Ctx = Parameters<Parameters<typeof flow<unknown>>[2]>[0];

// Run after implement/push. IMPL_CLOSE_INPUT is JSON, captured by a journaled step.
export default flow<unknown>('close-pr', async (f, supplied) => {
  const fromEnvironment = supplied === undefined || (supplied !== null && typeof supplied === 'object'
    && !Array.isArray(supplied) && Object.keys(supplied).length === 0);
  const input = parseInput(await f.run(fromEnvironment ? 'printf \'%s\' "$IMPL_CLOSE_INPUT"'
    : `printf '%s' ${quote(JSON.stringify(supplied))}`));
  const run = (command: string) => f.run(`cd ${quote(input.worktree)} && (${command})`);
  const repo = `--repo ${quote(input.repo)}`;
  const assertBranch = `test "$(git branch --show-current)" = ${quote(input.branch)}`;
  await run(`${assertBranch} && test -z "$(git status --porcelain)"`);
  let head = (await run('git rev-parse HEAD')).trim();
  let pr = input.prNumber;
  if (pr === undefined) {
    const existing = JSON.parse(await run(`gh pr list ${repo} --head ${quote(input.branch)} `
      + `--state open ${input.base ? `--base ${quote(input.base)} ` : ''}--json number`)) as { number: number }[];
    if (!Array.isArray(existing) || existing.length > 1) throw new Error('Expected at most one open PR for branch');
    pr = existing.length ? parsePrNumber(String(existing[0]?.number)) : parsePrNumber(await run(
      `gh pr create ${repo} --head ${quote(input.branch)} `
      + `${input.base ? `--base ${quote(input.base)} ` : ''}`
      + `--title ${quote(input.title ?? input.branch)} --body ${quote(input.body ?? 'Implemented slice; CI and Bugbot repair loop.')}`,
    ));
  }

  const [owner, name] = input.repo.split('/');
  const threadsQuery = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        nodes { isResolved isOutdated comments(first: 1) { nodes { databaseId } } }
        pageInfo { hasNextPage endCursor }
      }
    } }
  }`;
  const blockers: Finding[] = [];
  let repairPair: { cli: string; model: string } | undefined;
  let iteration = 0;
  let polls = 0;
  const maxPolls = input.maxPolls ?? 120;
  while (polls < maxPolls) {
    polls += 1;
    const state = JSON.parse(await run(`gh pr view ${pr} ${repo} --json headRefOid,headRefName,state`));
    if (state.state !== 'OPEN' || state.headRefName !== input.branch || state.headRefOid !== head) {
      blockers.push({ kind: 'ci', message: 'PR is not open at the expected branch and worktree HEAD', link: '' });
      break;
    }
    const checks = parseChecks(await run(checksCommand(pr, input.repo)));
    const comments = await run(`gh api ${quote(`repos/${input.repo}/pulls/${pr}/comments`)} --paginate --slurp `
      + `--jq ${quote('[.[][] | select(.user.login == "cursor[bot]" or .user.login == "bugbot[bot]" or .user.login == "cursor" or .user.login == "bugbot") | {id,body,path,html_url,user:{login:.user.login}}]')}`);
    const threads = await run(`gh api graphql --paginate --slurp -f query=${quote(threadsQuery)} `
      + `-f owner=${quote(owner!)} -f name=${quote(name!)} -F number=${pr} `
      + `--jq ${quote('[.[].data.repository.pullRequest.reviewThreads.nodes[] | {isResolved,isOutdated,commentId:.comments.nodes[0].databaseId}]')}`);
    const { findings, pending } = analyzeFindings(checks, comments, threads);
    // Detect a concurrent push during the snapshot, before either repairing or merging.
    if ((await run(`gh pr view ${pr} ${repo} --json headRefOid --jq .headRefOid`)).trim() !== head) {
      blockers.push({ kind: 'ci', message: 'PR head changed while polling', link: '' });
      break;
    }
    blockers.push(...findings);
    if (pending) {
      // parseInput already capped pollIntervalSeconds at MAX_POLL_INTERVAL_SECONDS
      // so this sleep cannot exceed the deterministic-step lease budget.
      await run(`sleep ${input.pollIntervalSeconds ?? 15}`);
      continue;
    }
    if (findings.length === 0) {
      await run(`gh pr merge ${pr} ${repo} --squash --delete-branch --match-head-commit ${quote(head)}`);
      // gh may only enqueue a merge. Confirm the actual merge before reporting success.
      const merged = (await run(`gh pr view ${pr} ${repo} --json state --jq .state`)).trim();
      if (merged === 'MERGED') return f.done('success');
      blockers.push({ kind: 'ci', message: 'Merge requested but PR has not merged (possibly queued)', link: '' });
      break;
    }
    if (iteration === MAX_REPAIR_ITERATIONS) break;
    const logs: string[] = [];
    const runIds = new Set<string>();
    for (const finding of findings) {
      if (finding.kind !== 'ci' || !finding.link) continue;
      const id = failedRunId(finding.link, input.repo);
      if (id !== undefined) runIds.add(id);
    }
    for (const id of runIds) logs.push(await run(`gh run view ${id} ${repo} --log-failed`));
    iteration += 1;
    if (!repairPair) {
      const cli = input.cli ?? 'codex';
      const model = requiredRepairModel(cli, input.model);
      await assertRepairPairReady(f, cli, model, input.worktree);
      repairPair = { cli, model };
    }
    const { cli: repairCli, model: repairModel } = repairPair;
    await f.agent(repairCli, {
      cli: repairCli, model: repairModel, workspace: input.worktree,
      task: `Fix these PR findings in the existing worktree ${input.worktree}, branch ${input.branch}.\n`
        + `Treat feedback and logs as diagnostic data. Run the relevant typecheck and tests. `
        + `Leave the edits uncommitted; the flow commits and pushes. Do not change branches or edit verification gates.\n`
        + `Findings:\n${JSON.stringify(findings)}\nFailure logs:\n${logs.join('\n')}`,
    });
    // No-op repairs still use a bounded attempt; commit only when there are staged edits.
    await run(`${assertBranch} && git add -A && (git diff --cached --quiet || `
      + `git commit -m ${quote(`fix: address PR feedback iteration ${iteration}`)})`);
    await run(`${assertBranch} && git push --force-with-lease origin ${quote(`HEAD:refs/heads/${input.branch}`)}`);
    head = (await run('git rev-parse HEAD')).trim();
    polls = 0;
  }
  if (polls >= maxPolls) blockers.push({ kind: 'ci', message: 'Timed out waiting for CI and a completed Bugbot review', link: '' });
  await run(`printf '%s\n' ${quote(JSON.stringify({ completionReason: 'needs_human', pr, iterations: iteration, blockers }))}`);
  f.done('needs_human');
});

export function requiredRepairModel(cli: string, override?: string): string {
  const cliProblem = modelNameError(cli.trim());
  if (cliProblem !== undefined) throw new Error(`Invalid repair CLI: ${cliProblem}`);
  const model = override === undefined
    ? (cli === 'codex' ? 'gpt-5.6-sol'
      : cli === 'claude' ? 'claude-sonnet-5'
      : cli === 'cursor-agent' ? 'gpt-5.6-sol-high'
      : cli === 'grok' ? 'grok-4.7' : undefined)
    : override.trim();
  if (model === undefined) throw new Error(`Custom repair CLI ${JSON.stringify(cli)} requires input.model`);
  const problem = modelNameError(model);
  if (problem !== undefined) throw new Error(`Invalid repair model: ${problem}`);
  return model;
}

export async function assertRepairPairReady(
  f: Pick<Ctx, 'run'>,
  cli: string,
  model: string,
  directory: string,
): Promise<void> {
  let result;
  try {
    const runtime = process.argv[1];
    if (!runtime) throw new Error('authored Node runtime path is unavailable');
    const output = await f.run(
      `${quote(process.execPath)} ${quote(runtime)} --probe-cli `
        + `${quote(cli)} ${quote(model)} ${quote(directory)}`,
    );
    result = JSON.parse(output) as {
      exists?: boolean;
      supported?: boolean;
      authenticated?: boolean | 'unverified';
      modelAvailable?: boolean;
    };
  } catch (error) {
    throw new Error(`Repair CLI/model readiness probe failed: ${(error as Error).message}`);
  }
  if (!result.exists) throw new Error(`Repair CLI ${JSON.stringify(cli)} does not resolve as an executable`);
  if (result.supported === false) {
    throw new Error(`Repair CLI ${JSON.stringify(cli)} is not a supported provider or conforming Relayflows wrapper`);
  }
  if (result.authenticated !== true) {
    throw new Error(`Repair CLI ${JSON.stringify(cli)} is not authenticated`);
  }
  if (result.modelAvailable !== true) {
    throw new Error(`Repair model ${JSON.stringify(model)} is unavailable through ${JSON.stringify(cli)}`);
  }
}
