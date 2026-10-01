export function scanDeclarative(document: Record<string, unknown>, where: string): {
  calls: number;
  missing: string[];
  pairs: string[];
} {
  const flowCli = typeof document.cli === 'string' ? document.cli : undefined;
  const agents = new Map<string, { cli?: string; model?: string }>();
  if (Array.isArray(document.agents)) {
    for (const candidate of document.agents as Array<Record<string, unknown>>) {
      if (typeof candidate.name === 'string') {
        agents.set(candidate.name, {
          cli: typeof candidate.cli === 'string' ? candidate.cli : undefined,
          model: typeof candidate.model === 'string' ? candidate.model : undefined,
        });
      }
    }
  } else if (document.agents && typeof document.agents === 'object') {
    for (const [name, value] of Object.entries(document.agents as Record<string, unknown>)) {
      const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      agents.set(name, {
        cli: typeof candidate.cli === 'string' ? candidate.cli : undefined,
        model: typeof candidate.model === 'string' ? candidate.model : undefined,
      });
    }
  }
  const workflows = Array.isArray(document.workflows) ? document.workflows as Array<Record<string, unknown>> : [];
  const steps = [
    ...(Array.isArray(document.steps) ? document.steps as Array<Record<string, unknown>> : []),
    ...workflows.flatMap(workflow => Array.isArray(workflow.steps)
      ? workflow.steps as Array<Record<string, unknown>>
      : []),
  ];
  const modelSteps = steps.filter(candidate => candidate.type === 'agent'
    || candidate.type === 'llm'
    || (candidate.type === undefined
      && typeof candidate.agent === 'string'
      && typeof candidate.task === 'string'));
  const missing: string[] = [];
  const pairs: string[] = [];
  for (const [name, agent] of agents) {
    if (!agent.cli) missing.push(`${where}:agent:${name} has no effective CLI`);
    if (!agent.model) missing.push(`${where}:agent:${name} has no explicit model`);
    if (agent.cli && agent.model) pairs.push(`${agent.cli}/${agent.model}`);
  }
  for (const step of modelSteps) {
    const label = `${where}:${String(step.id ?? step.name)}`;
    const named = typeof step.agent === 'string' ? agents.get(step.agent) : undefined;
    const cli = typeof step.cli === 'string' ? step.cli : named?.cli ?? flowCli;
    const model = typeof step.model === 'string' ? step.model : named?.model;
    if (!cli) missing.push(`${label} has no effective CLI`);
    if (!model) missing.push(`${label} has no explicit model`);
    if (cli && model) pairs.push(`${cli}/${model}`);
  }
  return { calls: modelSteps.length, missing, pairs };
}
