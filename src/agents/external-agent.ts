/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import {
  AsyncQueue,
  BaseAgent,
  type BaseAgentConfig,
  type BaseTool,
  createEvent,
  createEventActions,
  type Event,
  type InvocationContext,
  isBaseTool,
  isBaseToolset,
  ReadonlyContext,
  type ToolUnion,
} from "@google/adk";
import type { Content } from "@google/genai";
import type { ExternalAgentCredentialProvider } from "./auth/credential-provider.js";
import { NoopCredentialProvider } from "./auth/credential-provider.js";
import type { ExternalAgentEvent } from "./events.js";
import type { ExternalAgentDriver } from "./external-agent-driver.js";
import { PlaceholderExternalAgentDriver } from "./external-agent-driver.js";
import {
  createAnswersConsumedEvent,
  createConfirmationRequestEvent,
  describeAnswers,
  type ExternalAgentConfirmationOptions,
  guardPermissionRequest,
  normalizeDecision,
  type PermissionDecision,
  type PermissionRequest,
  permissionSignature,
  readConfirmationAnswers,
} from "./permissions/confirmation.js";
import {
  deriveSubAgentPermissionPolicy,
  resolveEffectivePermissions,
} from "./permissions/inheritance.js";
import type { ExternalAgentPermissionPolicy } from "./permissions/schema.js";
import type { ExternalAgentProviderDefinition } from "./provider/schema.js";
import { toolDetail, traceAdkEvent } from "./telemetry.js";
import {
  type AdkToolBridge,
  createAdkToolBridge,
  type SkippedTool,
} from "./tools/adk-tool-bridge.js";
import { type DelegationOptions, ToolGateway } from "./tools/tool-gateway.js";

function normalizeToolCallArgs(input: unknown): Record<string, unknown> {
  if (input === undefined) {
    return {};
  }

  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  return { input };
}

/**
 * Policy of `agent` capped by every `ExternalAgent` above it in the agent
 * tree, folded root-down with the same rule `ToolGateway` applies on each
 * delegation (`deriveSubAgentPermissionPolicy(parentEffective, childOwn)`,
 * where a parent with no policy counts as `ask`). Other agents in between
 * (LlmAgent, Sequential...) do not delegate through the gateway and are
 * skipped. With no ExternalAgent ancestor this is the agent's own policy.
 */
function ancestryPermissions(
  agent: ExternalAgent,
): ExternalAgentPermissionPolicy | undefined {
  const chain: ExternalAgent[] = [];
  for (let node = agent.parentAgent; node; node = node.parentAgent) {
    if (node instanceof ExternalAgent) chain.unshift(node);
  }
  if (chain.length === 0) {
    return agent.permissions;
  }
  let effective = chain[0]?.permissions;
  for (const next of [...chain.slice(1), agent]) {
    effective = deriveSubAgentPermissionPolicy(effective, next.permissions);
  }
  return effective;
}

/**
 * Configuration of an {@link ExternalAgent}. Extends ADK's `BaseAgentConfig`, so
 * `beforeAgentCallback` / `afterAgentCallback` and the workflow-node options
 * (`retryConfig`, `timeout`, `inputSchema`, `outputSchema`, `stateSchema`,
 * `isolationScope`, ...) are accepted and honored by ADK when the agent runs as
 * a node. The whole object is forwarded to `super()` so `BaseAgent.clone()` can
 * rebuild the agent (provider, driver, permissions included).
 *
 * `clone()` reuses the same `driver` instance. The Claude SDK driver keeps its
 * resume state per agent instance, so clones sharing it never resume each
 * other's transcript. Codex keeps its thread id in session state keyed by agent
 * name, so clones that run in the same session need distinct names (ADK already
 * requires unique names within an agent tree):
 * `agent.clone({ name: "b" })`. Pass a fresh `driver` in the overrides when a
 * driver holds other per-run state.
 */
export interface ExternalAgentConfig extends BaseAgentConfig {
  provider: ExternalAgentProviderDefinition;
  driver?: ExternalAgentDriver;
  credentialProvider?: ExternalAgentCredentialProvider;
  instruction?: string;
  workingDirectory?: string;
  permissions?: ExternalAgentPermissionPolicy;
  /**
   * Delegation behavior when `subAgents` are present. `finalAnswer: "subagent"`
   * (default, ADK-like) makes a sub-agent's terminal answer the answer of the
   * turn; `"coordinator"` lets the coordinator synthesize afterwards.
   */
  delegation?: DelegationOptions;
  /**
   * How permission prompts of the runtime (the `ask` mode) are answered. Without
   * it every prompt is denied. A confirmation never widens the effective policy
   * and `read-only` is never confirmable. Supported by drivers that can
   * intercept prompts (Claude Agent SDK); the Codex SDK exposes no approval hook.
   *
   * `allowedPaths` is checked on the runtime's blocked path and on the path
   * inputs of file tools, after normalization and symlink resolution.
   * `allowNetwork: false` is only enforced for `WebFetch`/`WebSearch`: a shell
   * command (`Bash curl ...`) or an MCP tool can reach the network without the
   * guard seeing it, so the approver decides those.
   */
  confirmation?: ExternalAgentConfirmationOptions;
  /**
   * ADK tools and toolsets to expose to the external runtime (as in
   * `LlmAgent.tools`). Supported by drivers that can host tools (Claude Agent
   * SDK, through its in-process MCP server); other drivers ignore them and do
   * not advertise `capabilities.tools`. Tools that require confirmation go
   * through {@link ExternalAgentConfig.confirmation}. Expose sub-agents with
   * `subAgents`, never with `AgentTool` (it breaks permission inheritance).
   *
   * Limits: of the actions a tool sets on its context, only `stateDelta` is
   * published. `escalate`, `transferToAgent`, `skipSummarization` and
   * `artifactDelta` are dropped, and a tool that calls
   * `toolContext.requestConfirmation()` inside `execute` is not confirmed
   * (its call fails closed). Use `requireConfirmation` on the tool instead.
   */
  tools?: ToolUnion[];
  /**
   * Tools that stay available when the effective policy is `read-only`, by
   * original tool name. In `read-only` every other ADK tool is hidden, because
   * a tool can have side effects the policy cannot see.
   */
  readOnlyTools?: readonly string[];
}

/**
 * ADK agent backed by an external runtime driver (Claude, Codex, Gemini CLI...).
 *
 * As a `BaseAgent` it is also a `BaseNode`: ADK's inherited `runImpl` delegates
 * to `runAsync`, so no override is needed to drop it into a `Workflow`.
 *
 * See {@link ExternalAgentConfig} for how `clone()` treats the driver.
 */
export class ExternalAgent extends BaseAgent<ExternalAgentConfig> {
  readonly provider: ExternalAgentProviderDefinition;
  readonly driver: ExternalAgentDriver;
  readonly credentialProvider: ExternalAgentCredentialProvider;
  readonly instruction?: string;
  readonly workingDirectory?: string;
  readonly permissions?: ExternalAgentPermissionPolicy;
  readonly delegation?: DelegationOptions;
  readonly confirmation?: ExternalAgentConfirmationOptions;
  readonly tools: ToolUnion[];
  readonly readOnlyTools: readonly string[];

  constructor(config: ExternalAgentConfig) {
    super(config);
    this.provider = config.provider;
    this.driver =
      config.driver ?? new PlaceholderExternalAgentDriver(config.provider.id);
    this.credentialProvider =
      config.credentialProvider ?? new NoopCredentialProvider();
    this.instruction = config.instruction;
    this.workingDirectory = config.workingDirectory;
    this.permissions = config.permissions;
    this.delegation = config.delegation;
    this.confirmation = config.confirmation;
    this.tools = config.tools ?? [];
    this.readOnlyTools = config.readOnlyTools ?? [];
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const credential = await this.credentialProvider.getCredential({
      providerId: this.provider.id,
      envAllowlist: this.provider.envAllowlist,
    });
    // Never more permissive than the delegating parent, whatever agents ADK put
    // in between (see permissions/inheritance.ts), and never more permissive
    // than the ExternalAgents above it in the tree, even when ADK routes a turn
    // straight to this agent (a resumable app resuming its confirmation) and
    // the session carries no inherited policy.
    const permissions = resolveEffectivePermissions(
      context.session,
      ancestryPermissions(this),
    );

    // Own controller so abandoning the generator (iterator.return(), e.g. a
    // ParallelAgent sibling failing or the client disconnecting) cancels the
    // driver. It is linked to the Runner's signal so upstream aborts propagate.
    const controller = new AbortController();
    const abortSignal = context.abortSignal
      ? AbortSignal.any([context.abortSignal, controller.signal])
      : controller.signal;
    let driverDone = false;
    // A sub-agent paused on the user (confirmation, input, credential,
    // long-running call): its request event is already on the timeline, so the
    // coordinator stops, as ADK ends an invocation on a long-running call.
    let subAgentInterrupted = false;

    const queue = new AsyncQueue<Event>();
    const rootAgent = this.rootAgent;
    const subAgents = this.subAgents;
    const toolGateway =
      subAgents.length > 0
        ? new ToolGateway({
            rootAgent,
            subAgents,
            parentContext: context,
            parentPermissions: permissions,
            delegation: this.delegation,
            onInterrupt: () => {
              subAgentInterrupted = true;
              context.endInvocation = true;
              controller.abort();
            },
            eventSink: (event) => {
              traceAdkEvent({ event, context, providerId: this.provider.id });
              queue.push(event);
            },
          })
        : undefined;

    // Answers the human gave on this turn to confirmation requests this agent
    // emitted earlier. Each approves/rejects one retry of the same call.
    const answers = readConfirmationAnswers(context, this.name);
    const answered = new Map(
      answers.map((answer) => [answer.signature, answer.confirmed]),
    );
    if (answers.length > 0) {
      const consumed = createAnswersConsumedEvent({
        context,
        agentName: this.name,
        answers,
      });
      traceAdkEvent({ event: consumed, context, providerId: this.provider.id });
      queue.push(consumed);
    }
    let confirmationRequested = false;
    const instruction = answers.length
      ? [this.instruction, describeAnswers(answers)]
          .filter((part): part is string => Boolean(part))
          .join("\n\n")
      : this.instruction;

    const requestPermission = async (
      request: PermissionRequest,
    ): Promise<PermissionDecision> => {
      const guarded = guardPermissionRequest(permissions, request, {
        workingDirectory: this.workingDirectory,
      });
      if (guarded) {
        return guarded;
      }
      const signature = permissionSignature(request.toolName, request.input);
      if (answered.has(signature)) {
        const confirmed = answered.get(signature);
        answered.delete(signature);
        return confirmed
          ? { behavior: "allow" }
          : { behavior: "deny", message: "Rejected by the user." };
      }
      const approver = this.confirmation?.approver;
      if (approver) {
        try {
          return normalizeDecision(await approver(request));
        } catch {
          return { behavior: "deny", message: "The approver failed." };
        }
      }
      if (this.confirmation?.adk && !confirmationRequested) {
        // ADK-native path: ask through `adk_request_confirmation`, end this
        // invocation, and let the next turn carry the human's answer.
        confirmationRequested = true;
        const event = createConfirmationRequestEvent({
          context,
          agentName: this.name,
          request,
        });
        traceAdkEvent({ event, context, providerId: this.provider.id });
        queue.push(event);
        context.endInvocation = true;
        controller.abort();
        return {
          behavior: "deny",
          message:
            "Waiting for the user to confirm this call. Stop now; the task resumes after the answer.",
        };
      }
      return {
        behavior: "deny",
        message: this.confirmation?.adk
          ? "Another confirmation is already pending."
          : "Denied: no approver is configured for this agent.",
      };
    };

    const adkTools =
      this.tools.length > 0
        ? await this.resolveAdkTools(context, permissions)
        : undefined;

    void (async () => {
      try {
        for await (const event of this.driver.run({
          provider: this.provider,
          context,
          abortSignal,
          instruction,
          requestPermission,
          ...(adkTools
            ? {
                adkTools,
                emitStateDelta: (stateDelta: Record<string, unknown>) => {
                  if (Object.keys(stateDelta).length === 0) return;
                  const event = createEvent({
                    invocationId: context.invocationId,
                    author: this.name,
                    branch: context.branch,
                    actions: createEventActions({ stateDelta }),
                  });
                  traceAdkEvent({
                    event,
                    context,
                    providerId: this.provider.id,
                  });
                  queue.push(event);
                },
              }
            : {}),
          workingDirectory: this.workingDirectory,
          credential,
          permissions,
          agent: this,
          rootAgent,
          subAgents,
          toolGateway,
          runtimeSession: {
            id: context.invocationId,
            rootAgentName: rootAgent.name,
          },
        })) {
          // A driver-level completion event is authoritative. Some provider SDKs emit their
          // terminal result after the subprocess exits but keep the transport iterator open while
          // it waits for EOF. Waiting for that EOF strands ADK's Runner even though the turn is
          // already complete. Breaking here calls return() on the driver iterator, which lets the
          // provider release its transport in finally.
          if (
            event.type === "completed" ||
            confirmationRequested ||
            subAgentInterrupted
          ) {
            break;
          }
          if (toolGateway) {
            // Native ADK transfer makes the sub-agent's turn the final answer
            // and the coordinator stays silent afterwards: drop the coordinator's
            // redundant re-narration (a terminal text turn right after a
            // successful delegation). Partial chunks always pass through, and any
            // other activity (a new tool call) means the coordinator is still
            // working.
            if (event.type === "output" && !event.partial) {
              if (toolGateway.consumeFinalAnswer()) {
                continue;
              }
            } else if (event.type === "tool_call") {
              toolGateway.resetFinalAnswer();
            }
          }
          const adkEvent = this.toAdkEvent(event, context);
          if (adkEvent) {
            traceAdkEvent({
              event: adkEvent,
              context,
              providerId: this.provider.id,
            });
            queue.push(adkEvent);
          }
        }
      } catch (error) {
        // After a confirmation request (ours or a sub-agent's) we aborted the
        // driver on purpose; its abort error is not a failure of the turn.
        if (!confirmationRequested && !subAgentInterrupted) {
          queue.fail(error);
        }
      } finally {
        driverDone = true;
        // Closing in finally covers normal EOF, an explicit terminal event, cancellation, and an
        // iterator return. No consumer is left waiting on the queue.
        queue.close();
      }
    })();

    try {
      yield* queue;
    } finally {
      if (!driverDone) {
        controller.abort();
      }
    }
  }

  /**
   * Resolves the configured ADK tools for this invocation and applies the
   * permission policy: under `read-only` only `readOnlyTools` stay exposed.
   */
  private async resolveAdkTools(
    context: InvocationContext,
    permissions: ExternalAgentPermissionPolicy | undefined,
  ): Promise<AdkToolBridge> {
    if (permissions?.mode !== "read-only") {
      return createAdkToolBridge(this.tools, context);
    }
    // Filter on the tool objects by their original name BEFORE the bridge
    // names them: matching generated names (`adk_tool__get_2`) would let an
    // unrelated tool literally named `get_2` through `readOnlyTools: ["get"]`.
    const allowed = new Set(this.readOnlyTools);
    // Only `BaseTool` objects reach the bridge, so it never lists anything a
    // second time: a toolset that failed here (an MCP server whose first
    // connection failed) must not be listed again, unfiltered.
    const visible: BaseTool[] = [];
    const skipped: SkippedTool[] = [];
    for (const entry of this.tools) {
      if (isBaseTool(entry)) {
        if (allowed.has(entry.name)) visible.push(entry);
      } else if (isBaseToolset(entry)) {
        let tools: BaseTool[];
        try {
          tools = await entry.getTools(new ReadonlyContext(context));
        } catch {
          skipped.push({
            name: entry.constructor.name,
            reason: "toolset-failed",
          });
          continue;
        }
        visible.push(
          ...tools.filter((tool) => isBaseTool(tool) && allowed.has(tool.name)),
        );
      } else {
        skipped.push({
          name: (entry as { name?: string })?.name ?? "(unnamed)",
          reason: "not-a-tool",
        });
      }
    }
    const bridge = await createAdkToolBridge(visible, context);
    return {
      declarations: bridge.declarations,
      skipped: [...skipped, ...bridge.skipped],
      has: (name) => bridge.has(name),
      execute: (name, args, invocation, options) =>
        bridge.execute(name, args, invocation, options),
    };
  }

  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsyncImpl(context);
  }

  protected toAdkEvent(
    event: ExternalAgentEvent,
    context: InvocationContext,
  ): Event | undefined {
    switch (event.type) {
      case "output": {
        return createEvent({
          invocationId: context.invocationId,
          author: this.name,
          branch: context.branch,
          content: { role: "model", parts: [{ text: event.content }] },
          partial: event.partial,
          turnComplete: event.turnComplete ?? !event.partial,
          customMetadata: metadataForExternalEvent(this.name, event),
          timestamp: event.timestamp,
          // Same contract as ADK's LlmAgent-as-node wrapper: the final text of a
          // non-partial turn is the node output, so a downstream Workflow node
          // receives it. Ignored outside a Workflow.
          ...(event.partial
            ? {}
            : {
                output: this.nodeOutput(event.content),
                nodeInfo: { messageAsOutput: true },
              }),
        });
      }
      case "error":
        return createEvent({
          invocationId: context.invocationId,
          author: this.name,
          branch: context.branch,
          errorCode: event.code ?? "EXTERNAL_AGENT_ERROR",
          errorMessage: event.message,
          customMetadata: metadataForExternalEvent(this.name, event),
          timestamp: event.timestamp,
        });
      case "tool_call":
        return createEvent({
          invocationId: context.invocationId,
          author: this.name,
          branch: context.branch,
          content: this.toolCallToContent(event),
          customMetadata: metadataForExternalEvent(this.name, event),
          timestamp: event.timestamp,
        });
      case "tool_result":
        return createEvent({
          invocationId: context.invocationId,
          author: this.name,
          branch: context.branch,
          content: this.toolResultToContent(event),
          customMetadata: metadataForExternalEvent(this.name, event),
          timestamp: event.timestamp,
        });
      case "state_delta":
        return createEvent({
          invocationId: context.invocationId,
          author: this.name,
          branch: context.branch,
          actions: createEventActions({ stateDelta: event.stateDelta }),
          customMetadata: metadataForExternalEvent(this.name, event),
          timestamp: event.timestamp,
        });
      case "started":
      case "completed":
        return undefined;
    }
  }

  /**
   * Node output for a final text turn, following ADK's `maybeSetOutput`
   * (workflow/run_llm_agent_as_node): with an `outputSchema` and non-blank text
   * the text is parsed as JSON; if parsing fails the raw text is kept and ADK's
   * output validation reports the mismatch.
   */
  private nodeOutput(text: string): unknown {
    if (this.outputSchema && text.trim()) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  }

  private toolCallToContent(
    event: Extract<ExternalAgentEvent, { type: "tool_call" }>,
  ): Content {
    return {
      role: "model",
      parts: [
        {
          functionCall: {
            id: event.callId,
            name: event.name,
            args: normalizeToolCallArgs(event.input),
          },
        },
      ],
    };
  }

  private toolResultToContent(
    event: Extract<ExternalAgentEvent, { type: "tool_result" }>,
  ): Content {
    const response =
      typeof event.result === "object" && event.result !== null
        ? (event.result as Record<string, unknown>)
        : { result: event.result };
    return {
      role: "user",
      parts: [
        {
          functionResponse: {
            id: event.callId,
            name: event.name,
            response: event.error
              ? { ...response, error: event.error }
              : response,
          },
        },
      ],
    };
  }
}

function metadataForExternalEvent(
  agentName: string,
  event: ExternalAgentEvent,
): Record<string, unknown> {
  const metadata = "metadata" in event && event.metadata ? event.metadata : {};
  return {
    ...metadata,
    title:
      typeof metadata.title === "string"
        ? metadata.title
        : readableExternalEventTitle(agentName, event),
    externalAgent: true,
  };
}

function readableExternalEventTitle(
  agentName: string,
  event: ExternalAgentEvent,
): string {
  switch (event.type) {
    case "output": {
      const itemType = stringValue(event.metadata?.itemType);
      const status = stringValue(event.metadata?.status);
      if (itemType) {
        return `${agentName}: ${itemType}${status ? ` ${status}` : ""}`;
      }
      return event.partial
        ? `${agentName}: progress`
        : `${agentName}: final response`;
    }
    case "error":
      return `${agentName}: error ${event.code ?? "EXTERNAL_AGENT_ERROR"}`;
    case "tool_call":
      return `${agentName}: ${event.name} call${toolDetail(event.input)}`;
    case "tool_result":
      return `${agentName}: ${event.name} response${toolDetail(event.result)}`;
    case "state_delta":
      return `${agentName}: state update`;
    case "started":
      return `${agentName}: started`;
    case "completed":
      return `${agentName}: completed`;
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
