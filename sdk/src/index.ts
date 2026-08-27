// @relayflows/sdk — TypeScript-first authoring SDK for Relayflows.
// Compiles specs (RFC-0001 §1 ladder) and speaks the journal protocol v0
// (kernel DESIGN.md §5).

export type {
  AgentStepSpec,
  AgentSurfaces,
  BaseStepSpec,
  BudgetSpec,
  DeterministicStepSpec,
  ExitCodeGate,
  FlowSpec,
  JsonSchemaGate,
  KernelAgentStep,
  KernelAgentSurfaces,
  KernelBudgetSpec,
  KernelDeterministicStep,
  KernelLlmStep,
  KernelPermissionsSpec,
  KernelRetryPolicy,
  KernelRunSpec,
  KernelStepCommon,
  KernelStepSpec,
  KernelVerificationSpec,
  LlmStepSpec,
  OutputContainsGate,
  PermissionsSpec,
  RecoveryMode,
  StreamSurface,
  StepSpec,
  StepType,
  VerificationGateType,
  VerificationSpec,
  WorkspaceSurface,
} from './spec.js';
export { SPEC_SCHEMA_VERSION } from './spec.js';

export { canonicalize, specHash } from './canonical.js';
export {
  compileAndHash,
  compileSpec,
  compileYaml,
  compileYamlToCanonicalJson,
  toKernelSpec,
  CompileError,
} from './compile.js';
export { validateSpec, type ValidationResult } from './validate.js';

export type {
  CompletionReason,
  EventEmitParams,
  EventEmitResult,
  HelloParams,
  HelloResult,
  JournalReadParams,
  JournalReadResult,
  ProtocolError,
  Request,
  Response,
  RunGetParams,
  RunGetResult,
  RunOutcome,
  RunCompletionReason,
  RunResumeParams,
  RunResumeResult,
  RunStatus,
  RunWatchParams,
  RunWatchResult,
  ServerEvent,
  StepCompleteParams,
  StepCompleteResult,
  StepDispatchEvent,
  StepHeartbeatParams,
  StepHeartbeatResult,
  StreamAppendParams,
  StreamAppendResult,
  StreamReadParams,
  StreamReadResult,
  Verb,
  VerbContract,
  WorkerAttachParams,
  WorkerAttachResult,
} from './protocol.js';
export { JOURNAL_WRITE_FAILED, PROTOCOL_VERSION } from './protocol.js';

export { JournalClient, type JournalClientOptions } from './journal-client.js';
