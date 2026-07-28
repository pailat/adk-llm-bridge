/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

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
import {
  WORKFLOW_SCRIPT_PROTOCOL,
  WORKFLOW_SCRIPT_PROTOCOL_VERSION,
} from "./protocol.js";
import {
  loadReleaseQuickJS,
  type QuickJSModuleLoader,
} from "./quickjs-loader.js";
import type {
  WorkflowScriptGeneratorSession,
  WorkflowScriptGeneratorTurn,
  WorkflowScriptRuntime,
  WorkflowScriptRuntimeCapabilities,
  WorkflowScriptSessionOptions,
} from "./types.js";

const encoder = new TextEncoder();

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

export interface QuickJSSyncGeneratorRuntimeOptions {
  loader?: QuickJSModuleLoader;
  limits?: WorkflowExecutionLimits;
  /** Test/diagnostic hook invoked after every created VM is disposed. */
  onDispose?: () => void;
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
): Required<WorkflowExecutionLimits> {
  const resolved = {
    ...DEFAULT_WORKFLOW_EXECUTION_LIMITS,
    ...defaults,
    ...overrides,
  };
  for (const [name, value] of Object.entries(resolved)) {
    positiveInteger(name, value);
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
  } catch {
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

  constructor(
    context: QuickJSContext,
    runtime: QuickJSRuntime,
    nextFunction: QuickJSHandle,
    limits: Required<WorkflowExecutionLimits>,
    signal: AbortSignal | undefined,
    onDispose: (() => void) | undefined,
  ) {
    this.#context = context;
    this.#runtime = runtime;
    this.#nextFunction = nextFunction;
    this.#limits = limits;
    this.#signal = signal;
    this.#onDispose = onDispose;
    runtime.setInterruptHandler(
      () => this.#signal?.aborted === true || Date.now() >= this.#deadline,
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
    if (this.#signal?.aborted) {
      throw new WorkflowError(
        "WORKFLOW_ABORTED",
        "Workflow script was aborted",
      );
    }

    const serialized = serializeMessage(value, this.#limits.maxMessageBytes);
    this.#deadline = Date.now() + this.#limits.cpuTimeMs;
    const argument = context.newString(serialized);
    try {
      const result = context.callFunction(
        nextFunction,
        context.undefined,
        argument,
      );
      if (result.error) {
        const message = guestError(context, result.error);
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
      const serializedTurn = context.getString(result.value);
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

  dispose(): void {
    if (!this.#context || !this.#runtime) {
      return;
    }
    this.#nextFunction?.dispose();
    this.#nextFunction = undefined;
    this.#context.dispose();
    this.#context = undefined;
    this.#runtime.dispose();
    this.#runtime = undefined;
    this.#onDispose?.();
  }
}

/** Bounded QuickJS sync runtime for JSON-driven generator scripts. */
export class QuickJSSyncGeneratorRuntime implements WorkflowScriptRuntime {
  readonly capabilities = QUICKJS_SYNC_CAPABILITIES;
  readonly #loader: QuickJSModuleLoader;
  readonly #limits: WorkflowExecutionLimits | undefined;
  readonly #onDispose: (() => void) | undefined;

  constructor(options: QuickJSSyncGeneratorRuntimeOptions = {}) {
    this.#loader = options.loader ?? loadReleaseQuickJS;
    this.#limits = options.limits;
    this.#onDispose = options.onDispose;
  }

  async createSession(
    options: WorkflowScriptSessionOptions,
  ): Promise<WorkflowScriptGeneratorSession> {
    const limits = resolveLimits(this.#limits, options.limits);
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

    const runtime = module.newRuntime();
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(limits.stackBytes);
    const setupDeadline = Date.now() + limits.cpuTimeMs;
    runtime.setInterruptHandler(
      () => options.signal?.aborted === true || Date.now() >= setupDeadline,
    );
    const context = runtime.newContext();
    let nextFunction: QuickJSHandle | undefined;
    try {
      const program = `
        (() => {
          "use strict";
          const __input = JSON.parse(${JSON.stringify(serializedInput)});
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
          const __factory = function* (__workflowContext) {
            const ctx = __workflowContext;
            ${options.source}\n
          };
          const __iterator = __factory(__ctx);
          return function __workflowNext(serialized) {
            const value = JSON.parse(serialized);
            return JSON.stringify(__iterator.next(value));
          };
        })()
      `;
      const evaluated = context.evalCode(
        program,
        options.filename ?? "workflow-script.js",
        { type: "global" },
      );
      if (evaluated.error) {
        const message = guestError(context, evaluated.error);
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
      );
    } catch (error) {
      nextFunction?.dispose();
      context.dispose();
      runtime.dispose();
      this.#onDispose?.();
      throw error;
    }
  }
}
