import type { WorkflowExecutionLimits } from "../contracts.js";

/** Capabilities guaranteed by the bundled workflow script runtime. */
export interface WorkflowScriptRuntimeCapabilities {
  /** Script engine used for isolation. */
  readonly engine: "quickjs";
  /** Scripts are generator functions that yield operations. */
  readonly generatorProtocol: true;
  /** Host calls happen between synchronous generator turns. */
  readonly synchronousHostBridge: true;
  /** Asyncify is not used; guest code never suspends inside a host call. */
  readonly asyncify: false;
  /** The guest heap size is capped. */
  readonly memoryLimit: true;
  /** The guest stack size is capped. */
  readonly stackLimit: true;
  /** Guest execution can be interrupted by timeout or abort. */
  readonly interruptHandler: true;
}

/** Options for creating one script session. */
export interface WorkflowScriptSessionOptions {
  /** Body of a synchronous JavaScript generator function. */
  source: string;
  /** JSON-compatible input exposed as `ctx.input`. */
  input?: unknown;
  /** Cancels guest execution at the next QuickJS interrupt check. */
  signal?: AbortSignal;
  /** Memory, stack and time limits applied to the guest. */
  limits?: WorkflowExecutionLimits;
  /** Diagnostic filename used in QuickJS exceptions. */
  filename?: string;
}

/** Result of advancing the guest generator once. */
export interface WorkflowScriptGeneratorTurn {
  /** True when the generator has returned. */
  done: boolean;
  /** The yielded operation, or the return value when `done` is true. */
  value?: unknown;
}

/** A single isolated QuickJS runtime and generator iterator. */
export interface WorkflowScriptGeneratorSession {
  /** True once the session has been disposed. */
  readonly disposed: boolean;
  /** Resumes the generator with the host result of the previous operation. */
  next(value?: unknown): WorkflowScriptGeneratorTurn;
  /** Frees the runtime; safe to call more than once. */
  dispose(): void;
}

/** Injectable boundary for alternative script isolation implementations. */
export interface WorkflowScriptRuntime {
  /** Isolation guarantees of this runtime. */
  readonly capabilities: WorkflowScriptRuntimeCapabilities;
  /**
   * Checks the limits a workflow declares, so a limit this runtime cannot
   * honor fails when the agent is built and not at its first run. Optional:
   * a runtime without it is checked only by `createSession`.
   *
   * @throws {@link WorkflowError} with code `WORKFLOW_DEFINITION_INVALID` for
   * a limit the runtime refuses.
   */
  validateLimits?(limits: WorkflowExecutionLimits | undefined): void;
  /** Creates an isolated session for one script execution. */
  createSession(
    options: WorkflowScriptSessionOptions,
  ): Promise<WorkflowScriptGeneratorSession>;
}
