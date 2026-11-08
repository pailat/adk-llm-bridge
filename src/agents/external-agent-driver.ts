/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { BaseAgent, BaseTool, InvocationContext } from "@google/adk";
import type { ExternalAgentCredential } from "./auth/schema.js";
import type { ExternalAgentEvent } from "./events.js";
import type {
  PermissionDecision,
  PermissionRequest,
} from "./permissions/confirmation.js";
import type { ExternalAgentPermissionPolicy } from "./permissions/schema.js";
import type { ExternalAgentProviderDefinition } from "./provider/schema.js";
import type { AgentRuntimeCapabilities } from "./runtime/capabilities.js";
import type { AgentRuntimeSession } from "./runtime/runtime-session.js";
import type { AdkToolBridge } from "./tools/adk-tool-bridge.js";
import type { ToolGateway } from "./tools/tool-gateway.js";

export interface ExternalAgentRunRequest {
  provider: ExternalAgentProviderDefinition;
  context: InvocationContext;
  instruction?: string;
  workingDirectory?: string;
  credential?: ExternalAgentCredential;
  permissions?: ExternalAgentPermissionPolicy;
  agent?: BaseAgent;
  rootAgent?: BaseAgent;
  subAgents?: readonly BaseAgent[];
  tools?: readonly BaseTool[];
  toolGateway?: ToolGateway;
  /**
   * ADK tools (`ExternalAgentConfig.tools`) the runtime may call, already
   * filtered by the effective permission policy (in `read-only` only the
   * explicitly allow-listed ones). Drivers that can host tools (the Claude SDK
   * through its in-process MCP server) advertise `adkTools.declarations` and run
   * calls with `adkTools.execute`. Tools that gate on confirmation come back as
   * `confirmationRequired`; resolve them with {@link requestPermission}.
   */
  adkTools?: AdkToolBridge;
  /**
   * Publishes session-state changes made by an ADK tool call as a `state_delta`
   * event on the agent's stream. Present whenever {@link adkTools} is.
   */
  emitStateDelta?: (stateDelta: Record<string, unknown>) => void;
  /**
   * Asks the host whether the runtime may run a tool call it is not
   * pre-authorized for (the `ask` flow). Resolves to a decision that never
   * exceeds the effective permission policy; `read-only` always denies. Drivers
   * that can intercept permission prompts (Claude `canUseTool`) call it and
   * must treat a rejection as a denial. Absent when the host handles no prompts.
   */
  requestPermission?: (
    request: PermissionRequest,
  ) => Promise<PermissionDecision>;
  runtimeSession?: AgentRuntimeSession;
  /**
   * First-class cancellation signal for the run. When this signal aborts,
   * drivers MUST stop streaming and release any spawned subprocess/SDK
   * resources (e.g. via the SDK's own abort/interrupt mechanism).
   *
   * This is the single, shared cancellation contract for all external-agent
   * drivers. When unset, drivers SHOULD fall back to
   * {@link InvocationContext.abortSignal} (`context.abortSignal`) for backward
   * compatibility. Use {@link resolveAbortSignal} to obtain the effective
   * signal honoring both sources.
   */
  abortSignal?: AbortSignal;
}

/**
 * Resolve the effective cancellation signal for a run, preferring the
 * first-class {@link ExternalAgentRunRequest.abortSignal} and falling back to
 * the ADK {@link InvocationContext.abortSignal}. Returns `undefined` when
 * neither is present.
 *
 * This is the one place every driver should call so they share a single
 * cancellation contract.
 */
export function resolveAbortSignal(
  request: Pick<ExternalAgentRunRequest, "abortSignal" | "context">,
): AbortSignal | undefined {
  return request.abortSignal ?? request.context?.abortSignal;
}

export interface ExternalAgentDriver {
  readonly providerId: string;
  capabilities?(): AgentRuntimeCapabilities;
  run(request: ExternalAgentRunRequest): AsyncIterable<ExternalAgentEvent>;
}

export class PlaceholderExternalAgentDriver implements ExternalAgentDriver {
  constructor(readonly providerId: string) {}

  async *run(): AsyncIterable<ExternalAgentEvent> {
    yield {
      type: "error",
      message:
        "No external agent driver is configured. Provider-specific runtime execution is not part of the foundation layer.",
      recoverable: true,
    };
  }
}
