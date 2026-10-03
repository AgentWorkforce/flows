import { basename } from 'node:path';
import { declarationStringError } from './input.ts';

/** Current direct-probe adapter pins; every wrapper must name its model explicitly upstream. */
export function generatedModelForCli(cli: string): string | undefined {
  const provider = basename(cli).replace(/\.exe$/iu, '');
  if (provider === 'claude') return 'claude-sonnet-5';
  if (provider === 'codex') return 'gpt-5.6-sol';
  return undefined;
}

/** Custom wrappers have no adapter default, so their operator must pin a model. */
export function requiredReviewerModel(cli: string, override?: string): string {
  const normalizedCli = cli.trim();
  const cliProblem = declarationStringError(normalizedCli);
  if (cliProblem !== undefined) throw new Error(`Invalid reviewer CLI: ${cliProblem}`);
  const model = override === undefined ? generatedModelForCli(normalizedCli) : override.trim();
  if (model === undefined) throw new Error(`Custom reviewer CLI ${JSON.stringify(cli)} requires reviewerModel`);
  const modelProblem = declarationStringError(model);
  if (modelProblem !== undefined) throw new Error(`Invalid reviewer model: ${modelProblem}`);
  return model;
}
