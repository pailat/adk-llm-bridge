import type {
  QuickJSContext,
  QuickJSHandle,
  QuickJSRuntime,
} from "quickjs-emscripten-core";
import {
  DEFAULT_WORKFLOW_EXECUTION_LIMITS,
  WorkflowError,
  type WorkflowExecutionLimits,
} from "../contracts.js";
import { monotonicNow } from "../internal/monotonic-clock.js";
import {
  WORKFLOW_SCRIPT_PROTOCOL,
  WORKFLOW_SCRIPT_PROTOCOL_VERSION,
} from "./protocol.js";
import {
  discardReleaseQuickJS,
  loadReleaseQuickJS,
  type QuickJSModuleLike,
  type QuickJSModuleLoader,
  quickJSModule,
} from "./quickjs-loader.js";
import type {
  WorkflowScriptGeneratorSession,
  WorkflowScriptGeneratorTurn,
  WorkflowScriptRuntime,
  WorkflowScriptRuntimeCapabilities,
  WorkflowScriptSessionOptions,
} from "./types.js";

const encoder = new TextEncoder();

/** Capabilities of {@link QuickJSSyncGeneratorRuntime}: bounded memory, stack and CPU time. */
export const QUICKJS_SYNC_CAPABILITIES: WorkflowScriptRuntimeCapabilities =
  Object.freeze({
    engine: "quickjs",
    generatorProtocol: true,
    synchronousHostBridge: true,
    asyncify: false,
    memoryLimit: true,
    stackLimit: true,
    interruptHandler: true,
  });

/** Options for {@link QuickJSSyncGeneratorRuntime}. */
export interface QuickJSSyncGeneratorRuntimeOptions {
  /**
   * Resolves the QuickJS module.
   *
   * @defaultValue Lazily loads the optional `quickjs-emscripten-core` release variant.
   */
  loader?: QuickJSModuleLoader;
  /**
   * Runtime-wide execution limits; per-session limits override them.
   *
   * @defaultValue `DEFAULT_WORKFLOW_EXECUTION_LIMITS`
   */
  limits?: WorkflowExecutionLimits;
  /** Test/diagnostic hook invoked after every created VM is disposed. */
  onDispose?: () => void;
  /**
   * Called with the module a run poisoned (a host stack overflow or a wasm
   * assertion), so the loader can build a new one before the next session.
   *
   * @defaultValue Drops the cached release module of the default loader.
   */
  discardModule?: (module: QuickJSModuleLike) => void;
  /**
   * Largest `stackBytes` accepted. Only a test raises it, to force a host
   * stack overflow.
   *
   * @internal
   * @defaultValue {@link QUICKJS_MAX_STACK_BYTES}
   */
  maxStackBytes?: number;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WorkflowError(
      "WORKFLOW_DEFINITION_INVALID",
      `${name} must be a positive safe integer`,
      { name, value },
    );
  }
  return value;
}

function resolveLimits(
  defaults: WorkflowExecutionLimits | undefined,
  overrides: WorkflowExecutionLimits | undefined,
  maxStackBytes: number,
): Required<WorkflowExecutionLimits> {
  const resolved = {
    ...DEFAULT_WORKFLOW_EXECUTION_LIMITS,
    ...defaults,
    ...overrides,
  };
  for (const [name, value] of Object.entries(resolved)) {
    positiveInteger(name, value);
  }
  if (resolved.stackBytes > maxStackBytes) {
    throw new WorkflowError(
      "WORKFLOW_DEFINITION_INVALID",
      `stackBytes must not exceed ${maxStackBytes} bytes: a larger sandbox stack can overflow the host stack before QuickJS reports the limit`,
      {
        name: "stackBytes",
        value: resolved.stackBytes,
        maxBytes: maxStackBytes,
      },
    );
  }
  return resolved;
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function rejectModuleSyntax(source: string): void {
  if (/\bimport\b/u.test(source)) {
    throw new WorkflowError(
      "WORKFLOW_SCRIPT_INVALID",
      "Workflow scripts cannot import modules",
    );
  }
}

function serializeMessage(value: unknown, maxBytes: number): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (cause) {
    throw new WorkflowError(
      "WORKFLOW_SCRIPT_INVALID",
      "Sandbox messages must be JSON-serializable",
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  if (serialized === undefined) {
    serialized = "null";
  }
  const size = byteLength(serialized);
  if (size > maxBytes) {
    throw new WorkflowError(
      "WORKFLOW_LIMIT_EXCEEDED",
      `Sandbox message exceeds the ${maxBytes} byte limit`,
      { actualBytes: size, maxBytes },
    );
  }
  return serialized;
}

/**
 * Largest `stackBytes` a script workflow may ask for.
 *
 * @remarks
 * QuickJS runs on the host's own stack inside the wasm module. Its own stack
 * check (`stackBytes`) sees guest frames, not the native recursion of its
 * parser or of `JSON`, so a host with a small stack can overflow first. The
 * limit keeps ordinary deep recursion (the 22 patterns measured, see
 * `docs/workflow-orchestration.md`) inside QuickJS, where it ends with a clean
 * `WORKFLOW_LIMIT_EXCEEDED`. It does not make the host path impossible: a
 * deeply nested source given to `eval` can still exhaust the host stack.
 * Every host overflow is contained instead: the run ends with
 * `WORKFLOW_LIMIT_EXCEEDED` and the module is poisoned (see
 * {@link QuickJSSyncGeneratorRuntime}). A larger `stackBytes` is refused with
 * `WORKFLOW_DEFINITION_INVALID`.
 */
export const QUICKJS_MAX_STACK_BYTES = 32 * 1024;

/**
 * Modules that a host stack overflow or a wasm abort left in an unknown state.
 * The host `RangeError` unwinds the wasm without freeing the guest's objects
 * and can stop inside the allocator, so no session runs on such a module.
 */
const poisonedModules = new WeakSet<object>();

const POISONED_MESSAGE =
  "The QuickJS sandbox was reset after a host stack overflow or a wasm abort";

function isWasmAbort(error: unknown): boolean {
  return (
    error instanceof WebAssembly.RuntimeError ||
    (error instanceof Error && /^Aborted\(/u.test(error.message))
  );
}

/**
 * Maps an error from a call into the wasm that means the host stack was
 * exhausted or the module aborted; `undefined` for any other error.
 */
function hostFailure(
  error: unknown,
  phase: "turn" | "set-up",
): WorkflowError | undefined {
  const cause = error instanceof Error ? error.message : String(error);
  if (error instanceof RangeError) {
    return new WorkflowError(
      "WORKFLOW_LIMIT_EXCEEDED",
      `QuickJS ${phase === "turn" ? "execution" : "initialization"} limit exceeded: the host stack was exhausted (${cause}); the sandbox was reset`,
      { cause },
    );
  }
  if (isWasmAbort(error)) {
    return new WorkflowError(
      "WORKFLOW_LIMIT_EXCEEDED",
      `QuickJS ${phase === "turn" ? "execution" : "initialization"} limit exceeded: the sandbox aborted (${cause}); the sandbox was reset`,
      { cause },
    );
  }
  return undefined;
}

/** Disposes a runtime; true when the wasm asserted while freeing it. */
function disposeRuntime(runtime: QuickJSRuntime): boolean {
  try {
    runtime.dispose();
    return false;
  } catch (error) {
    // QuickJS asserts (wasm `Aborted(...)`) when a run left unreachable
    // objects behind: a host stack overflow, or a QuickJS path that leaks on
    // overflow. The limit error that caused the disposal must stay the
    // visible failure, so contain it; the caller discards the module.
    if (!isWasmAbort(error)) {
      throw error;
    }
    return true;
  }
}

function guestError(context: QuickJSContext, handle: QuickJSHandle): string {
  try {
    const dumped = context.dump(handle) as unknown;
    if (dumped && typeof dumped === "object") {
      const error = dumped as { name?: unknown; message?: unknown };
      const name = typeof error.name === "string" ? error.name : "Error";
      const message =
        typeof error.message === "string" ? error.message : String(dumped);
      return `${name}: ${message}`;
    }
    return String(dumped);
  } catch (error) {
    // A host overflow while reading the error poisons the module like any other.
    if (hostFailure(error, "turn")) throw error;
    return "Unknown QuickJS error";
  }
}

class QuickJSSyncGeneratorSession implements WorkflowScriptGeneratorSession {
  #context: QuickJSContext | undefined;
  #runtime: QuickJSRuntime | undefined;
  #nextFunction: QuickJSHandle | undefined;
  #deadline = 0;
  readonly #limits: Required<WorkflowExecutionLimits>;
  readonly #signal: AbortSignal | undefined;
  readonly #onDispose: (() => void) | undefined;
  readonly #poison: () => void;
  readonly #module: object;

  constructor(
    context: QuickJSContext,
    runtime: QuickJSRuntime,
    nextFunction: QuickJSHandle,
    limits: Required<WorkflowExecutionLimits>,
    signal: AbortSignal | undefined,
    onDispose: (() => void) | undefined,
    poison: () => void,
    module: object,
  ) {
    this.#poison = poison;
    this.#module = module;
    this.#context = context;
    this.#runtime = runtime;
    this.#nextFunction = nextFunction;
    this.#limits = limits;
    this.#signal = signal;
    this.#onDispose = onDispose;
    runtime.setInterruptHandler(
      () => this.#signal?.aborted === true || monotonicNow() >= this.#deadline,
    );
  }

  get disposed(): boolean {
    return !this.#context;
  }

  next(value?: unknown): WorkflowScriptGeneratorTurn {
    const context = this.#context;
    const nextFunction = this.#nextFunction;
    if (!context || !nextFunction) {
      throw new WorkflowError(
        "WORKFLOW_EXECUTION_ERROR",
        "Sandbox generator session has been disposed",
      );
    }
    if (poisonedModules.has(this.#module)) {
      // Another session (or this one) left the module in an unknown state.
      throw new WorkflowError("WORKFLOW_EXECUTION_ERROR", POISONED_MESSAGE);
    }
    if (this.#signal?.aborted) {
      throw new WorkflowError(
        "WORKFLOW_ABORTED",
        "Workflow script was aborted",
      );
    }

    const serialized = serializeMessage(value, this.#limits.maxMessageBytes);
    this.#deadline = monotonicNow() + this.#limits.cpuTimeMs;
    let argument: QuickJSHandle;
    try {
      argument = context.newString(serialized);
    } catch (error) {
      throw this.#contain(error);
    }
    try {
      let result: ReturnType<QuickJSContext["callFunction"]>;
      try {
        result = context.callFunction(
          nextFunction,
          context.undefined,
          argument,
        );
      } catch (error) {
        throw this.#contain(error);
      }
      if (result.error) {
        let message: string;
        try {
          message = guestError(context, result.error);
        } catch (error) {
          throw this.#contain(error);
        }
        result.error.dispose();
        if (this.#signal?.aborted) {
          throw new WorkflowError(
            "WORKFLOW_ABORTED",
            "Workflow script was aborted",
          );
        }
        if (/interrupted|out of memory|stack overflow/i.test(message)) {
          throw new WorkflowError(
            "WORKFLOW_LIMIT_EXCEEDED",
            `QuickJS execution limit exceeded: ${message}`,
          );
        }
        throw new WorkflowError(
          "WORKFLOW_SCRIPT_INVALID",
          `Workflow script failed: ${message}`,
        );
      }
      let serializedTurn: string;
      try {
        serializedTurn = context.getString(result.value);
      } catch (error) {
        throw this.#contain(error);
      }
      result.value.dispose();
      if (byteLength(serializedTurn) > this.#limits.maxMessageBytes) {
        throw new WorkflowError(
          "WORKFLOW_LIMIT_EXCEEDED",
          `Sandbox message exceeds the ${this.#limits.maxMessageBytes} byte limit`,
        );
      }
      try {
        return JSON.parse(serializedTurn) as WorkflowScriptGeneratorTurn;
      } catch (cause) {
        throw new WorkflowError(
          "WORKFLOW_SCRIPT_INVALID",
          "Workflow script returned a malformed generator turn",
          { cause: cause instanceof Error ? cause.message : String(cause) },
        );
      }
    } finally {
      argument.dispose();
      this.#deadline = Number.POSITIVE_INFINITY;
    }
  }

  /** Poisons the module for a host failure and types it; other errors pass. */
  #contain(error: unknown): unknown {
    const failure = hostFailure(error, "turn");
    if (!failure) return error;
    this.#poison();
    return failure;
  }

  dispose(): void {
    if (!this.#context || !this.#runtime) {
      return;
    }
    this.#nextFunction?.dispose();
    this.#nextFunction = undefined;
    this.#context.dispose();
    this.#context = undefined;
    const runtime = this.#runtime;
    this.#runtime = undefined;
    if (disposeRuntime(runtime)) this.#poison();
    this.#onDispose?.();
  }
}

/**
 * Bounded QuickJS sync runtime for JSON-driven generator scripts.
 *
 * @remarks
 * Each session owns one QuickJS runtime with memory, stack and CPU limits.
 * The guest has no host bindings: it talks to the host only through
 * JSON-serialized messages exchanged between generator turns.
 */
export class QuickJSSyncGeneratorRuntime implements WorkflowScriptRuntime {
  readonly capabilities = QUICKJS_SYNC_CAPABILITIES;
  readonly #loader: QuickJSModuleLoader;
  readonly #limits: WorkflowExecutionLimits | undefined;
  readonly #onDispose: (() => void) | undefined;
  readonly #discardModule: (module: QuickJSModuleLike) => void;
  readonly #maxStackBytes: number;

  /**
   * @param options - Loader, default limits, dispose hook and module reset.
   */
  constructor(options: QuickJSSyncGeneratorRuntimeOptions = {}) {
    this.#loader = options.loader ?? loadReleaseQuickJS;
    this.#limits = options.limits;
    this.#onDispose = options.onDispose;
    this.#discardModule = options.discardModule ?? discardReleaseQuickJS;
    this.#maxStackBytes = options.maxStackBytes ?? QUICKJS_MAX_STACK_BYTES;
  }

  /**
   * Checks limits without creating a session.
   *
   * @param limits - Limits a workflow declares; they are merged over the
   * runtime defaults.
   * @throws {@link WorkflowError} with code `WORKFLOW_DEFINITION_INVALID` for a
   * non-positive limit or a `stackBytes` above {@link QUICKJS_MAX_STACK_BYTES}.
   */
  validateLimits(limits: WorkflowExecutionLimits | undefined): void {
    resolveLimits(this.#limits, limits, this.#maxStackBytes);
  }

  /**
   * Compiles a script and returns a session positioned before the first turn.
   *
   * @param options - Script source, input, abort signal and limits.
   * @returns A generator session the caller must dispose.
   * @throws {@link WorkflowError} with code `WORKFLOW_DEFINITION_INVALID` for a non-positive limit, `WORKFLOW_LIMIT_EXCEEDED` for oversized source or input, `WORKFLOW_SCRIPT_INVALID` for module syntax or an initialization failure, `WORKFLOW_ABORTED` when the signal is already aborted, and `WORKFLOW_SANDBOX_UNAVAILABLE` when QuickJS cannot be loaded.
   */
  async createSession(
    options: WorkflowScriptSessionOptions,
  ): Promise<WorkflowScriptGeneratorSession> {
    const limits = resolveLimits(
      this.#limits,
      options.limits,
      this.#maxStackBytes,
    );
    const sourceSize = byteLength(options.source);
    if (sourceSize > limits.maxSourceBytes) {
      throw new WorkflowError(
        "WORKFLOW_LIMIT_EXCEEDED",
        `Workflow source exceeds the ${limits.maxSourceBytes} byte limit`,
        { actualBytes: sourceSize, maxBytes: limits.maxSourceBytes },
      );
    }
    rejectModuleSyntax(options.source);
    if (options.signal?.aborted) {
      throw new WorkflowError(
        "WORKFLOW_ABORTED",
        "Workflow script was aborted",
      );
    }
    const serializedInput = serializeMessage(
      options.input ?? null,
      limits.maxMessageBytes,
    );
    const module = await this.#loader().catch((cause: unknown) => {
      if (cause instanceof WorkflowError) {
        throw cause;
      }
      throw new WorkflowError(
        "WORKFLOW_SANDBOX_UNAVAILABLE",
        "QuickJS sandbox dependencies are unavailable",
        { cause: cause instanceof Error ? cause.message : String(cause) },
      );
    });

    if (poisonedModules.has(module)) {
      throw new WorkflowError(
        "WORKFLOW_SANDBOX_UNAVAILABLE",
        "The QuickJS module was poisoned by a host stack overflow or a wasm abort; the loader must return a new module",
      );
    }
    const runtime = quickJSModule(module).newRuntime();
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(limits.stackBytes);
    let poisoned = false;
    const poison = (): void => {
      if (poisoned) return;
      poisoned = true;
      poisonedModules.add(module);
      this.#discardModule(module);
    };
    const setupDeadline = monotonicNow() + limits.cpuTimeMs;
    runtime.setInterruptHandler(
      () => options.signal?.aborted === true || monotonicNow() >= setupDeadline,
    );
    const context = runtime.newContext();
    let nextFunction: QuickJSHandle | undefined;
    try {
      const program = `
        (() => {
          "use strict";
          // Captured before any guest code runs. Guest code never sees these
          // bindings, and replacing JSON, Reflect, Object or the generator
          // methods later does not change how turns are driven or encoded.
          const __parse = JSON.parse;
          const __stringify = JSON.stringify;
          const __apply = Reflect.apply;
          const __getPrototypeOf = Object.getPrototypeOf;
          const __GeneratorFunction = __getPrototypeOf(
            function* () {},
          ).constructor;
          const __generatorNext = __getPrototypeOf(
            __getPrototypeOf((function* () {})()),
          ).next;
          const __input = __parse(${JSON.stringify(serializedInput)});
          const __inputText = typeof __input === "string"
            ? __input
            : Array.isArray(__input?.parts)
              ? __input.parts
                  .map((part) => typeof part?.text === "string" ? part.text : "")
                  .join("")
              : "";
          const __operation = (op, payload) => Object.freeze({
            protocol: ${JSON.stringify(WORKFLOW_SCRIPT_PROTOCOL)},
            version: ${WORKFLOW_SCRIPT_PROTOCOL_VERSION},
            op,
            ...payload,
          });
          const __ctx = Object.freeze({
            input: __input,
            inputText: __inputText,
            run: (step) => __operation("run", { step }),
            parallel: (steps, options) => __operation("parallel", {
              steps,
              ...(options === undefined ? {} : { options }),
            }),
            emit: (event) => __operation("emit", { event }),
            spawnAgent: (request) => __operation("spawnAgent", { request }),
            listAgents: () => __operation("listAgents", {}),
            releaseAgent: (name) => __operation("releaseAgent", { name }),
          });
          // QuickJS builds the function from the joined source text, so a
          // source that starts with "})," can close the wrapper and run an
          // expression at construction time, in global scope and without
          // these bindings. Such a source can only replace the factory. The
          // factory must therefore be a generator function, and every turn
          // is driven by the generator "next" captured above, which throws
          // for any object that is not a real generator.
          const __factory = __GeneratorFunction(
            "__workflowContext",
            ${JSON.stringify(`"use strict";
const ctx = __workflowContext;
${options.source}
`)},
          );
          if (
            typeof __factory !== "function" ||
            __getPrototypeOf(__factory) !== __GeneratorFunction.prototype
          ) {
            throw new TypeError("Workflow script did not compile to a generator");
          }
          const __iterator = __factory(__ctx);
          return function __workflowNext(serialized) {
            const value = __parse(serialized);
            return __stringify(__apply(__generatorNext, __iterator, [value]));
          };
        })()
      `;
      let evaluated: ReturnType<QuickJSContext["evalCode"]>;
      try {
        evaluated = context.evalCode(
          program,
          options.filename ?? "workflow-script.js",
          { type: "global" },
        );
      } catch (error) {
        // A host stack overflow in the parser or a wasm abort while the script
        // is set up poisons the module like one in a turn.
        const failure = hostFailure(error, "set-up");
        if (failure) {
          poison();
          throw failure;
        }
        throw error;
      }
      if (evaluated.error) {
        let message: string;
        try {
          message = guestError(context, evaluated.error);
        } catch (error) {
          const failure = hostFailure(error, "set-up");
          if (!failure) throw error;
          poison();
          throw failure;
        }
        evaluated.error.dispose();
        if (options.signal?.aborted) {
          throw new WorkflowError(
            "WORKFLOW_ABORTED",
            "Workflow script was aborted",
          );
        }
        if (/interrupted|out of memory|stack overflow/i.test(message)) {
          throw new WorkflowError(
            "WORKFLOW_LIMIT_EXCEEDED",
            `QuickJS initialization limit exceeded: ${message}`,
          );
        }
        throw new WorkflowError(
          "WORKFLOW_SCRIPT_INVALID",
          `Workflow script could not be initialized: ${message}`,
        );
      }
      nextFunction = evaluated.value;
      return new QuickJSSyncGeneratorSession(
        context,
        runtime,
        nextFunction,
        limits,
        options.signal,
        this.#onDispose,
        poison,
        module,
      );
    } catch (error) {
      nextFunction?.dispose();
      context.dispose();
      if (disposeRuntime(runtime)) poison();
      this.#onDispose?.();
      throw error;
    }
  }
}
