/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import {
  AsyncQueue,
  BaseAgent,
  type BaseAgentConfig,
  createEvent,
  createEventActions,
  type Event,
  type InvocationContext,
} from "@google/adk";
import type { Content } from "@google/genai";
import type { ExternalAgentCredentialProvider } from "./auth/credential-provider.js";
import { NoopCredentialProvider } from "./auth/credential-provider.js";
import type { ExternalAgentEvent } from "./events.js";
import type { ExternalAgentDriver } from "./external-agent-driver.js";
import { PlaceholderExternalAgentDriver } from "./external-agent-driver.js";
import { resolveEffectivePermissions } from "./permissions/inheritance.js";
import type { ExternalAgentPermissionPolicy } from "./permissions/schema.js";
import type { ExternalAgentProviderDefinition } from "./provider/schema.js";
import { toolDetail, traceAdkEvent } from "./telemetry.js";
import {
  consumeDelegationFinalAnswer,
  ToolGateway,
} from "./tools/tool-gateway.js";

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
 * Configuration of an {@link ExternalAgent}. Extends ADK's `BaseAgentConfig`, so
 * `beforeAgentCallback` / `afterAgentCallback` and the workflow-node options
 * (`retryConfig`, `timeout`, `inputSchema`, `outputSchema`, `stateSchema`,
 * `isolationScope`, ...) are accepted and honored by ADK when the agent runs as
 * a node. The whole object is forwarded to `super()` so `BaseAgent.clone()` can
 * rebuild the agent (provider, driver, permissions included).
 *
 * Caveat: `clone()` reuses the same `driver` instance. Drivers keep resume state
 * keyed per ADK session (Claude SDK) or per agent name (Codex), so two clones
 * running in the same session would resume each other's conversation. When
 * cloning into parallel branches, pass a fresh `driver` (and a distinct `name`)
 * in the overrides: `agent.clone({ name: "b", driver: new XDriver() })`.
 */
export interface ExternalAgentConfig extends BaseAgentConfig {
  provider: ExternalAgentProviderDefinition;
  driver?: ExternalAgentDriver;
  credentialProvider?: ExternalAgentCredentialProvider;
  instruction?: string;
  workingDirectory?: string;
  permissions?: ExternalAgentPermissionPolicy;
}

/**
 * ADK agent backed by an external runtime driver (Claude, Codex, Gemini CLI...).
 *
 * As a `BaseAgent` it is also a `BaseNode`: ADK's inherited `runImpl` delegates
 * to `runAsync`, so no override is needed to drop it into a `Workflow`.
 *
 * `clone()` shares the driver instance with the original (see
 * {@link ExternalAgentConfig}); override `driver` when cloning for concurrent use.
 */
export class ExternalAgent extends BaseAgent<ExternalAgentConfig> {
  readonly provider: ExternalAgentProviderDefinition;
  readonly driver: ExternalAgentDriver;
  readonly credentialProvider: ExternalAgentCredentialProvider;
  readonly instruction?: string;
  readonly workingDirectory?: string;
  readonly permissions?: ExternalAgentPermissionPolicy;

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
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const credential = await this.credentialProvider.getCredential({
      providerId: this.provider.id,
      envAllowlist: this.provider.envAllowlist,
    });
    // Never more permissive than the delegating parent, whatever agents ADK put
    // in between (see permissions/inheritance.ts).
    const permissions = resolveEffectivePermissions(
      context.session,
      this.permissions,
    );

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
            eventSink: (event) => {
              traceAdkEvent({ event, context, providerId: this.provider.id });
              queue.push(event);
            },
          })
        : undefined;

    // Own controller so abandoning the generator (iterator.return(), e.g. a
    // ParallelAgent sibling failing or the client disconnecting) cancels the
    // driver. It is linked to the Runner's signal so upstream aborts propagate.
    const controller = new AbortController();
    const abortSignal = context.abortSignal
      ? AbortSignal.any([context.abortSignal, controller.signal])
      : controller.signal;
    let driverDone = false;

    void (async () => {
      try {
        for await (const event of this.driver.run({
          provider: this.provider,
          context,
          abortSignal,
          instruction: this.instruction,
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
          if (event.type === "completed") {
            break;
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
        queue.fail(error);
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
        // Native ADK transfer makes the sub-agent's turn the final answer and
        // the coordinator stays silent afterwards. When a delegation just
        // produced a terminal sub-agent answer, drop the root model's
        // redundant re-narration turn. Only a terminal (non-partial) text turn
        // consumes the flag; partial streaming chunks pass through untouched so
        // we never strip legitimate root narration from a non-delegation turn.
        if (!event.partial && consumeDelegationFinalAnswer(context)) {
          return undefined;
        }
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
