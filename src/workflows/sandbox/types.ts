/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { WorkflowExecutionLimits } from "../contracts.js";

/** Capabilities guaranteed by the bundled workflow script runtime. */
export interface WorkflowScriptRuntimeCapabilities {
  readonly engine: "quickjs";
  readonly generatorProtocol: true;
  readonly synchronousHostBridge: true;
  readonly asyncify: false;
  readonly memoryLimit: true;
  readonly stackLimit: true;
  readonly interruptHandler: true;
}

export interface WorkflowScriptSessionOptions {
  /** Body of a synchronous JavaScript generator function. */
  source: string;
  /** JSON-compatible input exposed as `ctx.input`. */
  input?: unknown;
  /** Cancels guest execution at the next QuickJS interrupt check. */
  signal?: AbortSignal;
  limits?: WorkflowExecutionLimits;
  /** Diagnostic filename used in QuickJS exceptions. */
  filename?: string;
}

export interface WorkflowScriptGeneratorTurn {
  done: boolean;
  value?: unknown;
}

/** A single isolated QuickJS runtime and generator iterator. */
export interface WorkflowScriptGeneratorSession {
  readonly disposed: boolean;
  next(value?: unknown): WorkflowScriptGeneratorTurn;
  dispose(): void;
}

/** Injectable boundary for alternative script isolation implementations. */
export interface WorkflowScriptRuntime {
  readonly capabilities: WorkflowScriptRuntimeCapabilities;
  createSession(
    options: WorkflowScriptSessionOptions,
  ): Promise<WorkflowScriptGeneratorSession>;
}
