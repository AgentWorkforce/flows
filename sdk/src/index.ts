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
  KernelTriggerSpec,
  KernelVerificationSpec,
  LlmStepSpec,
  OutputContainsGate,
  PermissionsSpec,
  RecoveryMode,
  StreamSurface,
  StepSpec,
  StepType,
  TriggerSpec,
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
  kernelToAuthoring,
  toKernelSpec,
  CompileError,
} from './compile.js';
export { validateSpec, type ValidationResult } from './validate.js';

export {
  preflight,
  type CliResolution,
  type CliResolutionSource,
  type PreflightDiagnostic,
  type PreflightOptions,
  type PreflightProbes,
  type PreflightResult,
} from './preflight.js';
export {
  CHECK_FAILURE_KINDS,
  CHECK_INPUT_FAILURE_KINDS,
  PREFLIGHT_FAILURE_KINDS,
  PREFLIGHT_WARNING_KINDS,
  isCheckFailureKind,
  type CheckFailureKind,
  type PreflightFailureKind,
  type PreflightWarningKind,
} from './failure-kinds.js';
export { runCli, type CheckInputDiagnostic, type CheckReport, type CliIo } from './cli.js';

export type {
  CompletionReason,
  EffectRecordParams,
  EffectRecordResult,
  EffectRef,
  EventEmitParams,
  EventEmitResult,
  HelloParams,
  HelloResult,
  JournalReadParams,
  JournalReadResult,
  ProtocolError,
  Pins,
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
export { AgentWorker, type AgentWorkerClient, type AgentWorkerOptions } from './worker.js';

export {
  HnMonitorRunner,
  POLL_INTERVAL_MS,
  type HnMonitorClient,
  type HnMonitorRunnerOptions,
} from './hn-monitor-runner.js';

export {
  validateWorkPackage,
  packageFromEntry,
  type ValidatedWorkPackage,
  type WorkPackageValidation,
  type WorkPackageValidationReason,
} from './backlog-picker.js';

export {
  consumeWorkPackage,
  type EmittedWorkPackage,
  type WorkPackageConsumption,
  type WorkPackageRefusalReason,
} from './work-package-consumer.js';

export {
  validateNextWorkPackage,
  type NextWorkPackageRefusalReason,
  type NextWorkPackageValidation,
  type WorkPackagePathExists,
} from './work-package-validator.js';

// Hacker News adapter — deliberately outside kernel/ (see sdk/src/hn-poller.ts).
export {
  pollHackerNewsOnce,
  HnPollFetchError,
  HN_TOP_STORIES_URL,
  type EventSink,
  type Fetcher,
  type PollOptions,
} from './hn-poller.js';

// Directory watcher — second proactive workload for gate 2 primitives.
// Non-provider: no HTTP, no API tokens, no gate-6 dependency. Proves the
// pattern generalizes without regressing RFC-0001 §6 (providers = relayfile
// adapters, not SDK code).
export {
  pollDirectoryOnce,
  type DirLister,
  type PollOptions as DirWatcherPollOptions,
} from './dir-watcher-poller.js';
