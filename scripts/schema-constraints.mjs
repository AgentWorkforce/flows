// Structural refinements enforced by sdk/src/validate.ts and input-binding.ts.
// Field sets and requiredness come only from the AST; these are value rules.
export function applyConstraints(defs, version) {
  const property = (type, field, rule) => Object.assign(defs[type].properties[field], rule);
  const nonempty = { minLength: 1 };
  const trimmed = { minLength: 1, pattern: '^\\S(?:[\\s\\S]*\\S)?$' };
  const positive = { type: 'integer', minimum: 1 };
  const safePositive = { ...positive, maximum: Number.MAX_SAFE_INTEGER };
  const integer = { type: 'integer', minimum: 0 };
  const decimal = { pattern: '^\\d+(\\.\\d+)?$' };
  const canonicalPath = {
    minLength: 1,
    // Optional / or nonempty scheme:// prefix; every component is nonempty,
    // distinct from . and .., and the complete path is trimmed.
    pattern: '^(?!\\s)(?![\\s\\S]*\\s$)(?:/|[^/]+://)?(?:(?!\\.{1,2}(?:/|$))[^/]+(?:/(?!\\.{1,2}(?:/|$))[^/]+)*)?$',
  };
  property('FlowSpec', 'version', { const: version });
  property('FlowSpec', 'steps', { minItems: 1 });
  for (const type of ['FlowSpec', 'BaseStepSpec', 'DeterministicStepSpec', 'LlmStepSpec', 'AgentStepSpec', 'TriggerSpec', 'StreamSurface']) {
    for (const field of ['name', 'cli', 'id', 'command', 'prompt', 'instruction', 'executor', 'stream', 'agent']) {
      if (defs[type].properties[field]) property(type, field, nonempty);
    }
  }
  for (const type of ['BaseStepSpec', 'DeterministicStepSpec', 'LlmStepSpec', 'AgentStepSpec']) {
    property(type, 'maxIterations', positive);
    Object.assign(defs[type].properties.dependsOn.items, nonempty);
    property(type, 'input', { propertyNames: { type: 'string', pattern: '\\S' } });
  }
  property('DeterministicStepSpec', 'timeoutMs', positive);
  for (const field of ['maxTokensIn', 'maxTokensOut']) property('BudgetSpec', field, integer);
  property('BudgetSpec', 'maxDollars', decimal);
  property('MemorySpec', 'query', { pattern: '\\S' });
  // Memory adds safe-integer bounds to the otherwise shared budget shape.
  property('MemorySpec', 'budget', {
    type: 'object', properties: Object.fromEntries(['maxTokensIn', 'maxTokensOut'].map(key => [key, { type: 'integer', maximum: Number.MAX_SAFE_INTEGER }])),
  });
  property('PlacementRequirements', 'expectedDurationMs', safePositive);
  property('TriggerSpec', 'staleAfterMs', safePositive);
  property('FlowSpec', 'agents', { propertyNames: { type: 'string', ...trimmed } });
  property('NamedAgentSpec', 'cli', trimmed);
  for (const type of ['NamedAgentSpec', 'LlmStepSpec', 'AgentStepSpec']) {
    property(type, 'model', { ...trimmed, allOf: [{ pattern: '^[^\\u0000-\\u001f\\u007f]*$' }] });
  }
  property('OutputBinding', 'step', { pattern: '\\S' });
  Object.assign(defs.OutputBinding.properties.path.items.oneOf[1], { ...integer, maximum: Number.MAX_SAFE_INTEGER });
  property('WorkspaceSurface', 'surface', canonicalPath);
  Object.assign(defs.AgentSurfaces.properties.external.items, canonicalPath);
  for (const key of ['fileGlobs', 'networkAllowlist']) Object.assign(defs.PermissionsSpec.properties[key].items, nonempty);
  property('OutputContainsGate', 'value', nonempty);
  // Runtime accepts this legacy spelling although ExitCodeGate omits it.
  defs.ExitCodeGate.properties.expect = { type: 'integer', const: 0, description: 'Legacy explicit success code. Only zero is supported.' };
  defs.JsonSchemaGate.properties.schema = { $ref: '#/$defs/OutputSchema', description: 'JSON Schema object or boolean; references and termination are checked by flows check.' };
  defs.JsonOutputSchema = { title: 'JsonOutputSchema', description: 'Structured output schema, compiled into json_schema verification.', type: 'object', allOf: [{ $ref: '#/$defs/OutputSchema' }] };
  for (const name of ['LlmStepSpec', 'AgentStepSpec']) defs[name].not = { required: ['output', 'verification'] };
  // SURFACE.md examples expressed in the current declarative dialect (the
  // document's run/llm shorthand and identity header are future surface sugar).
  defs.DeterministicStepSpec.examples = [{ id: 'diff', type: 'deterministic', command: 'git diff main' }];
  defs.LlmStepSpec.examples = [{ id: 'note', type: 'llm', prompt: 'One-line release note for the diff above.' }];
  defs.AgentStepSpec.examples = [{ id: 'review', type: 'agent', instruction: 'Review this diff for security issues.' }];
}
