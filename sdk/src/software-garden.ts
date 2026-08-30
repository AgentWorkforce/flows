import type { AgentStepSpec, FlowSpec, TriggerSpec } from './spec.js';
import { compileSpec } from './compile.js';

/** Customer-facing Software Garden configuration. */
export interface SoftwareGardenConfig {
  name: string;
  repository: string;
  issueLabel: string;
  implementer: string;
  reviewer: string;
  autoMerge?: boolean;
}

/**
 * Compile the Garden presentation layer to an ordinary Relayflow DAG.
 * Scheduling, claims, leases, retries, and deduplication stay kernel-owned.
 */
export function softwareGarden(config: SoftwareGardenConfig): FlowSpec {
  validateConfig(config);

  const trigger: TriggerSpec = {
    id: 'labeled-issue',
    executor: 'agent-worker',
    eventType: 'github.issue.labeled',
    pattern: { repository: config.repository, label: config.issueLabel },
    dedupeKeyTemplate: '{{payload.repository}}:{{payload.issue.number}}',
  };
  const steps: AgentStepSpec[] = [
    agentStep(
      'discover-issue',
      config.implementer,
      `Read the triggering ${config.repository} issue labeled ${config.issueLabel} and produce an implementation brief.`,
    ),
    agentStep(
      'implement-and-open-pr',
      config.implementer,
      `Implement the discovered issue in ${config.repository}, run its checks, and open a pull request.`,
      ['discover-issue'],
    ),
    {
      ...agentStep(
        'review-pr',
        config.reviewer,
        'Review the opened pull request. Finish with the exact word APPROVED only when the change is ready.',
        ['implement-and-open-pr'],
      ),
      verification: { type: 'output_contains', value: 'APPROVED' },
      maxIterations: 3,
    },
  ];
  if (config.autoMerge === true) {
    steps.push(agentStep(
      'merge-pr',
      config.implementer,
      'Merge the approved pull request and close the linked issue.',
      ['review-pr'],
    ));
  }

  return compileSpec({
    version: '0.1.0',
    name: config.name,
    description: `Software Garden for ${config.repository}`,
    triggers: [trigger],
    steps,
  });
}

function agentStep(
  id: string,
  cli: string,
  instruction: string,
  dependsOn?: string[],
): AgentStepSpec {
  return {
    id,
    type: 'agent',
    cli,
    instruction,
    ...(dependsOn === undefined ? {} : { dependsOn }),
    recoveryMode: 'reset',
  };
}

function validateConfig(config: SoftwareGardenConfig): void {
  for (const key of ['name', 'repository', 'issueLabel', 'implementer', 'reviewer'] as const) {
    if (typeof config[key] !== 'string' || config[key].trim() === '') {
      throw new TypeError(`Software Garden ${key} must be a non-empty string`);
    }
  }
}
