import { accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  AgentOptions,
  AgentResult,
  CloudHelper,
  Ctx,
  Step,
} from '@relayflows/surface';
import { getAuthoredFlowDefinition, type FlowHandle } from './authored-flow.js';
import { compileSpec, CompileError } from './compile.js';
import { SPEC_SCHEMA_VERSION, type FlowSpec, type StepSpec } from './spec.js';

export class AuthoredFlowCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthoredFlowCompileError';
  }
}

/** Import an authored module, invoke its body with input, and compile journal steps. */
export async function compileAuthoredFlow(path: string, input: unknown): Promise<FlowSpec> {
  const absolutePath = resolve(path);
  try {
    accessSync(absolutePath, constants.R_OK);
  } catch {
    throw new AuthoredFlowCompileError(`Flow "${path}" is not readable.`);
  }

  let authoredModule: Record<string, unknown>;
  try {
    authoredModule = await import(pathToFileURL(absolutePath).href) as Record<string, unknown>;
  } catch (error) {
    throw new AuthoredFlowCompileError(
      `Flow "${path}" could not be imported: ${errorMessage(error)}`,
    );
  }

  let definition;
  try {
    definition = getAuthoredFlowDefinition(authoredModule['default'] as FlowHandle);
  } catch (error) {
    throw new AuthoredFlowCompileError(
      `Flow "${path}" must default-export flow(...): ${errorMessage(error)}`,
    );
  }
  const headerKeys = Object.keys(definition.header);
  if (headerKeys.length > 0) {
    throw new AuthoredFlowCompileError(
      `Flow "${path}" declares unsupported direct-run header fields: ${headerKeys.join(', ')}.`,
    );
  }

  const recorder = new RecordingContext();
  try {
    await definition.body(recorder.context, input);
  } catch (error) {
    throw new AuthoredFlowCompileError(
      `Flow "${path}" could not compile its body: ${errorMessage(error)}`,
    );
  }
  try {
    return compileSpec({
      version: SPEC_SCHEMA_VERSION,
      name: definition.name,
      steps: recorder.steps,
    });
  } catch (error) {
    if (error instanceof CompileError) {
      throw new AuthoredFlowCompileError(
        `Flow "${path}" compiled to an invalid spec: ${error.errors.join('; ')}`,
      );
    }
    throw error;
  }
}

class RecordingContext {
  readonly steps: StepSpec[] = [];
  readonly context: Ctx;
  private frontier: string[] = [];
  private readonly awaiting = new Map<string, () => void>();
  private flushQueued = false;
  private nextOrdinal = 1;
  private done = false;

  constructor() {
    this.context = {
      run: (command) => this.recordRun(command),
      llm: (strings, ...values) => this.recordLlm(strings, values),
      agent: (name, options) => this.recordAgent(name, options),
      human: async () => { throw unsupported('human'); },
      dispatch: async () => { throw unsupported('dispatch'); },
      done: (reason) => this.recordDone(reason),
      cloud: rejectingCloudHelper(),
    };
  }

  private recordRun(command: string): Step<string> {
    if (typeof command !== 'string' || command.trim().length === 0) {
      throw new AuthoredFlowCompileError('f.run requires a non-empty command');
    }
    return this.recordStep<string>('run', (id, dependsOn) => ({
      id,
      type: 'deterministic',
      command,
      dependsOn,
    }));
  }

  private recordLlm(strings: TemplateStringsArray, values: unknown[]): Step<string> {
    const prompt = interpolate(strings, values);
    return this.recordStep<string>('llm', (id, dependsOn) => ({
      id,
      type: 'llm',
      prompt,
      dependsOn,
    }));
  }

  private recordAgent(name: string, options: AgentOptions): Step<AgentResult> {
    if (name.trim().length === 0 || options.task.trim().length === 0) {
      throw new AuthoredFlowCompileError('f.agent requires a non-empty name and task');
    }
    return this.recordStep<AgentResult>(`agent-${slug(name)}`, (id, dependsOn) => ({
      id,
      type: 'agent',
      instruction: options.task,
      dependsOn,
      ...(options.workspace === undefined
        ? {}
        : { surfaces: { workspace: [{ surface: options.workspace }] } }),
    }));
  }

  private recordStep<T>(
    prefix: string,
    make: (id: string, dependsOn: string[]) => StepSpec,
  ): Step<T> {
    if (this.done) throw new AuthoredFlowCompileError('a flow cannot add steps after f.done');
    const id = `${prefix}-${this.nextOrdinal}`;
    this.nextOrdinal += 1;
    this.steps.push(make(id, [...this.frontier]));
    return this.thenable<T>(id);
  }

  private thenable<T>(id: string): Step<T> {
    const placeholder = outputPlaceholder<T>(id);
    return {
      gate: () => {
        throw new AuthoredFlowCompileError(
          `step "${id}" uses a code predicate gate, which direct-run compilation cannot journal`,
        );
      },
      then: <TResult1 = T, TResult2 = never>(
        onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
        _onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): PromiseLike<TResult1 | TResult2> => new Promise<TResult1 | TResult2>((resolveThen, rejectThen) => {
        this.awaiting.set(id, () => {
          try {
            resolveThen(onfulfilled === undefined || onfulfilled === null
              ? placeholder as unknown as TResult1
              : onfulfilled(placeholder));
          } catch (error) {
            rejectThen(error);
          }
        });
        this.queueFlush();
      }),
    };
  }

  private queueFlush(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      const batch = [...this.awaiting.entries()];
      this.awaiting.clear();
      this.frontier = batch.map(([id]) => id);
      for (const [, settle] of batch) settle();
    });
  }

  private recordDone(reason: string): void {
    if (reason !== 'success') {
      throw new AuthoredFlowCompileError(
        `f.done("${reason}") cannot compile until that completionReason exists in the kernel contract`,
      );
    }
    this.done = true;
  }
}

function outputPlaceholder<T>(stepId: string): T {
  return new Proxy({}, {
    get: (_target, property) => {
      if (property === 'then') return undefined;
      if (property === Symbol.toPrimitive) {
        return () => { throw outputDependencyError(stepId); };
      }
      throw outputDependencyError(stepId);
    },
  }) as T;
}

function outputDependencyError(stepId: string): AuthoredFlowCompileError {
  return new AuthoredFlowCompileError(
    `step "${stepId}" output is used while compiling; output-dependent authored control flow is not yet supported`,
  );
}

function interpolate(strings: TemplateStringsArray, values: unknown[]): string {
  return strings.reduce((result, part, index) => (
    `${result}${part}${index < values.length ? String(values[index]) : ''}`
  ), '');
}

function rejectingCloudHelper(): CloudHelper {
  return new Proxy({}, {
    get: () => { throw unsupported('cloud'); },
  }) as CloudHelper;
}

function unsupported(verb: string): AuthoredFlowCompileError {
  return new AuthoredFlowCompileError(`f.${verb} is not supported by direct-run compilation`);
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'step';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown authored-flow error';
}
