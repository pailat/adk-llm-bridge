import type { BaseAgent, InvocationContext } from "@google/adk";
import type { ExternalAgentCredential } from "./auth/schema.js";
import {
  EXTERNAL_AGENT_NOT_CONFIGURED,
  type ExternalAgentEvent,
} from "./events.js";
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

/** Everything a driver needs to run one external-agent turn. */
export interface ExternalAgentRunRequest {
  /** The provider being run. */
  provider: ExternalAgentProviderDefinition;
  /** The ADK invocation context of the turn. */
  context: InvocationContext;
  /** The agent's system instruction. */
  instruction?: string;
  /** Directory the runtime works in. */
  workingDirectory?: string;
  /** Resolved credential, limited to the provider's env allowlist. */
  credential?: ExternalAgentCredential;
  /** Effective permission policy, already narrowed by any parent agent's policy. */
  permissions?: ExternalAgentPermissionPolicy;
  /** The ADK agent that is executing the run. */
  agent?: BaseAgent;
  /** The root agent of the ADK invocation. */
  rootAgent?: BaseAgent;
  /** ADK sub-agents the runtime may delegate to. */
  subAgents?: readonly BaseAgent[];
  /** Gateway that runs sub-agent delegation for the runtime. */
  toolGateway?: ToolGateway;
  /**
   * ADK tools (`ExternalAgentConfig.tools`) the runtime may call, already
   * filtered by the effective permission policy (in `read-only` only the
   * explicitly allow-listed ones). Drivers that can host tools (the Claude SDK
   * through its in-process MCP server) advertise `adkTools.declarations` and run
   * calls with `adkTools.execute`. Tools that gate on confirmation come back as
   * `confirmationRequired`; resolve them with {@link requestPermission}.
   *
   * A driver that reports a bridged call as a `tool_result` event must name it
   * by its exposed name (`adkTools.declarations[].name`) or by the MCP name
   * `mcp__adk_bridge__<exposed name>`; the agent matches results to ADK tools
   * by those names only.
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
  /**
   * Runtime session to resume, for a caller that runs the driver directly and
   * knows the runtime's own session or thread id.
   *
   * @remarks
   * `ExternalAgent` leaves it unset: it cannot know that id. The SDK drivers
   * resume `runtimeSession.id` when it is set:
   * - Codex SDK: `runtimeSession.id`, then the thread id saved in ADK session
   *   state.
   * - Claude Agent SDK: the driver's `resumeSessionId` option, then
   *   `runtimeSession.id`, then the id saved in ADK session state, then the
   *   id the driver captured earlier for the same ADK session.
   * - fx CLI: the driver's `resumeSessionId`, then `runtimeSession.id`, then
   *   the id saved in ADK session state (`persistSession: false` refuses it).
   *
   * The other CLI drivers refuse it.
   */
  runtimeSession?: AgentRuntimeSession;
  /**
   * Cancellation signal for the run. When it aborts, drivers MUST stop
   * streaming and release any spawned subprocess or SDK resources (for
   * example through the SDK's own abort or interrupt mechanism).
   *
   * This is the single cancellation contract for all external-agent drivers.
   * When unset, drivers SHOULD fall back to `context.abortSignal`. Use
   * {@link resolveAbortSignal} to get the effective signal from both sources.
   */
  abortSignal?: AbortSignal;
}

/**
 * Resolves the effective cancellation signal for a run.
 *
 * @remarks
 * Every driver should call this so they share one cancellation contract.
 *
 * @param request - The run request.
 * @returns `request.abortSignal` if set, otherwise `request.context.abortSignal`,
 * or `undefined` when neither is present.
 */
export function resolveAbortSignal(
  request: Pick<ExternalAgentRunRequest, "abortSignal" | "context">,
): AbortSignal | undefined {
  return request.abortSignal ?? request.context?.abortSignal;
}

/**
 * An MCP server the host declared on a driver, as the permission guard sees
 * it: no URL, command, header or secret.
 *
 * @experimental
 */
export interface ExternalAgentMcpServerGrant {
  /** The server name; its tools are `mcp__<name>__<tool>`. */
  readonly name: string;
  /** Tool names without the prefix; absent means every tool. */
  readonly tools?: readonly string[];
  /** The host's attestation that the listed tools only read. */
  readonly readOnly: boolean;
}

/**
 * Runs one external runtime and reports what it does as events.
 *
 * @remarks
 * A driver is a thin adapter: it starts the runtime, maps its output to
 * {@link ExternalAgentEvent}s and honors the cancellation signal. It does not
 * decide permissions; it applies the policy in {@link ExternalAgentRunRequest.permissions}.
 */
export interface ExternalAgentDriver {
  /** Id of the provider this driver runs. */
  readonly providerId: string;
  /**
   * Model id the driver was configured with, if any. `ExternalAgent` writes it
   * to `gen_ai.request.model` on its spans; the model the runtime actually used
   * comes from the `started`/`completed` events (`gen_ai.response.model`).
   */
  readonly model?: string;
  /**
   * The small/fast model pin the driver was configured with, if any (the
   * Claude drivers' `smallFastModel`). Compared with the models a run billed:
   * see `ExternalAgentModelInfo.unexpected`.
   */
  readonly smallFastModel?: string;
  /**
   * Whether the driver was built with `requireExplicitModel`. A run that then
   * billed an unexpected model gets the `UNEXPECTED_MODEL` warning.
   */
  readonly requireExplicitModel?: boolean;
  /**
   * Whether the runtime reports the model it actually ran, on `started` or
   * `completed`. Only a driver that sets this to `true` has its reported
   * model trusted as the resolved model; absent means `false`.
   */
  readonly reportsResolvedModel?: boolean;
  /** @returns The features this driver supports. Absent means none are claimed. */
  capabilities?(): AgentRuntimeCapabilities;
  /**
   * The MCP servers the host declared on this driver, with their tool
   * allowlists and read-only attestation. The permission guard admits a
   * listed tool of these servers (`mcp__<server>__<tool>`) without
   * `allowNetwork: true`, and under `read-only` when the server is
   * `readOnly`. Absent means none.
   *
   * @returns One grant per declared server.
   * @experimental
   */
  declaredMcpServers?(): readonly ExternalAgentMcpServerGrant[];
  /**
   * Runs the turn.
   *
   * @param request - The run request.
   * @returns The stream of events, ending with a `completed` or `error` event.
   */
  run(request: ExternalAgentRunRequest): AsyncIterable<ExternalAgentEvent>;
}

/**
 * A driver that only reports that no real driver is configured.
 *
 * @remarks
 * `ExternalAgent` falls back to it so a missing driver surfaces as a
 * non-recoverable error event instead of a thrown exception.
 */
export class PlaceholderExternalAgentDriver implements ExternalAgentDriver {
  /** @param providerId - Id of the provider the error event is reported for. */
  constructor(readonly providerId: string) {}

  /**
   * Reports that no driver is configured.
   *
   * @returns A stream with one `error` event, code
   * `EXTERNAL_AGENT_NOT_CONFIGURED`. It is not recoverable: a retry runs the
   * same placeholder.
   */
  async *run(): AsyncIterable<ExternalAgentEvent> {
    yield {
      type: "error",
      code: EXTERNAL_AGENT_NOT_CONFIGURED,
      message:
        "No external agent driver is configured. Pass a `driver` to the ExternalAgent, or use a provider agent (CodexAgent, ClaudeAgent, GeminiCliAgent), which builds its own.",
      recoverable: false,
    };
  }
}
