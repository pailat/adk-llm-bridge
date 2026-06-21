/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import {
  BaseAgent,
  createEvent,
  createEventActions,
  type Event,
  type InvocationContext,
} from "@google/adk";
import type { Content } from "@google/genai";
import { trace } from "@opentelemetry/api";
import type { ExternalAgentCredentialProvider } from "./auth/credential-provider.js";
import { NoopCredentialProvider } from "./auth/credential-provider.js";
import type { ExternalAgentDriver } from "./external-agent-driver.js";
import { PlaceholderExternalAgentDriver } from "./external-agent-driver.js";
import type { ExternalAgentEvent } from "./events.js";
import type { ExternalAgentPermissionPolicy } from "./permissions/schema.js";
import type { ExternalAgentProviderDefinition } from "./provider/schema.js";
import { consumeDelegationFinalAnswer, ToolGateway } from "./tools/tool-gateway.js";

const tracerName = "gcp.vertex.agent";
const tracerVersion = "adk-llm-bridge";

function readPermissionOverride(
  context: InvocationContext,
): ExternalAgentPermissionPolicy | undefined {
  const override = (context as { externalAgentPermissionOverride?: unknown })
    .externalAgentPermissionOverride;
  return isPermissionPolicy(override) ? override : undefined;
}

function isPermissionPolicy(value: unknown): value is ExternalAgentPermissionPolicy {
  return Boolean(
    value &&
      typeof value === "object" &&
      "mode" in value &&
      typeof (value as { mode?: unknown }).mode === "string",
  );
}

function normalizeToolCallArgs(input: unknown): Record<string, unknown> {
  if (input === undefined) {
    return {};
  }

  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  return { input };
}

export interface ExternalAgentConfig {
  name: string;
  description?: string;
  provider: ExternalAgentProviderDefinition;
  driver?: ExternalAgentDriver;
  credentialProvider?: ExternalAgentCredentialProvider;
  instruction?: string;
  workingDirectory?: string;
  permissions?: ExternalAgentPermissionPolicy;
  subAgents?: BaseAgent[];
}

export class ExternalAgent extends BaseAgent {
  readonly provider: ExternalAgentProviderDefinition;
  readonly driver: ExternalAgentDriver;
  readonly credentialProvider: ExternalAgentCredentialProvider;
  readonly instruction?: string;
  readonly workingDirectory?: string;
  readonly permissions?: ExternalAgentPermissionPolicy;

  constructor(config: ExternalAgentConfig) {
    super({
      name: config.name,
      description: config.description,
      subAgents: config.subAgents,
    });
    this.provider = config.provider;
    this.driver =
      config.driver ?? new PlaceholderExternalAgentDriver(config.provider.id);
    this.credentialProvider =
      config.credentialProvider ?? new NoopCredentialProvider();
    this.instruction = config.instruction;
    this.workingDirectory = config.workingDirectory;
    this.permissions = config.permissions;
  }

  protected createInvocationContext(parentContext: InvocationContext): InvocationContext {
    const context = super.createInvocationContext(parentContext);
    const inherited = readPermissionOverride(parentContext);
    if (inherited) {
      (context as { externalAgentPermissionOverride?: ExternalAgentPermissionPolicy })
        .externalAgentPermissionOverride = inherited;
    }
    return context;
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const credential = await this.credentialProvider.getCredential({
      providerId: this.provider.id,
      envAllowlist: this.provider.envAllowlist,
    });
    const permissions = readPermissionOverride(context) ?? this.permissions;

    const queue = new AsyncEventQueue<Event>();
    const rootAgent = this.rootAgent ?? context.agent ?? this;
    const subAgents = this.subAgents;
    const toolGateway = subAgents.length > 0
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

    void (async () => {
      try {
        for await (const event of this.driver.run({
          provider: this.provider,
          context,
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
          const adkEvent = this.toAdkEvent(event, context);
          if (adkEvent) {
            traceAdkEvent({ event: adkEvent, context, providerId: this.provider.id });
            queue.push(adkEvent);
          }
        }
        queue.close();
      } catch (error) {
        queue.fail(error);
      }
    })();

    yield* queue;
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
    const response = typeof event.result === "object" && event.result !== null
      ? (event.result as Record<string, unknown>)
      : { result: event.result };
    return {
      role: "user",
      parts: [
        {
          functionResponse: {
            id: event.callId,
            name: event.name,
            response: event.error ? { ...response, error: event.error } : response,
          },
        },
      ],
    };
  }
}

function metadataForExternalEvent(agentName: string, event: ExternalAgentEvent): Record<string, unknown> {
  const metadata = "metadata" in event && event.metadata ? event.metadata : {};
  return {
    ...metadata,
    title: typeof metadata.title === "string"
      ? metadata.title
      : readableExternalEventTitle(agentName, event),
    externalAgent: true,
  };
}

function readableExternalEventTitle(agentName: string, event: ExternalAgentEvent): string {
  switch (event.type) {
    case "output": {
      const itemType = stringValue(event.metadata?.itemType);
      const status = stringValue(event.metadata?.status);
      if (itemType) {
        return `${agentName}: ${itemType}${status ? ` ${status}` : ""}`;
      }
      return event.partial ? `${agentName}: progress` : `${agentName}: final response`;
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

class AsyncEventQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  #closed = false;
  #error: unknown;

  push(item: T): void {
    if (this.#closed) {
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ value: item, done: false });
      return;
    }
    this.#items.push(item);
  }

  close(): void {
    this.#closed = true;
    while (this.#waiters.length > 0) {
      this.#waiters.shift()?.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    this.#error = error;
    this.#closed = true;
    while (this.#waiters.length > 0) {
      this.#waiters.shift()?.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
    };
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.#items.length > 0) {
      return Promise.resolve({ value: this.#items.shift() as T, done: false });
    }
    if (this.#error) {
      return Promise.reject(this.#error);
    }
    if (this.#closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }
}

function traceAdkEvent({
  event,
  context,
  providerId,
}: {
  event: Event;
  context: InvocationContext;
  providerId: string;
}): void {
  const spanName = spanNameForEvent(event);
  const tracer = trace.getTracer(tracerName, tracerVersion);
  const span = tracer.startSpan(spanName);
  try {
    const title = readableEventTitle(event);
    const metadata = readCustomMetadata(event);
    const llmRequest = buildSyntheticAdkLlmRequest(context, providerId);
    const parentToolName = stringValue(metadata.parentToolName);
    const parentToolCallId = stringValue(metadata.parentToolCallId);
    const metadataSubAgentName = stringValue(metadata.subAgentName);
    span.setAttributes({
      "gen_ai.system": "gcp.vertex.agent",
      "gen_ai.agent.name": event.author ?? context.agent?.name ?? "external_agent",
      "gen_ai.operation.name": spanName === "call_llm" ? "call_llm" : "execute_tool",
      "gen_ai.request.model": providerId,
      "gcp.vertex.agent.invocation_id": context.invocationId,
      "gcp.vertex.agent.session_id": readSessionId(context),
      "gcp.vertex.agent.event_id": event.id,
      "gcp.vertex.agent.provider_id": providerId,
      "gcp.vertex.agent.external_agent.name": event.author ?? "",
      "gcp.vertex.agent.event_title": title,
      "gcp.vertex.agent.branch": event.branch ?? "",
      "gcp.vertex.agent.subagent.name": metadataSubAgentName,
      "gcp.vertex.agent.parent_tool.name": parentToolName,
      "gcp.vertex.agent.parent_tool.call_id": parentToolCallId,
      "gcp.vertex.agent.llm_request": safeJsonSerialize(llmRequest),
      "gcp.vertex.agent.llm_response": safeJsonSerialize(event),
    });

    const functionCall = event.content?.parts?.find((part) => part.functionCall)?.functionCall;
    const functionResponse = event.content?.parts?.find((part) => part.functionResponse)?.functionResponse;
    if (functionCall) {
      span.setAttributes({
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": functionCall.name ?? "run_adk_subagent",
        "gen_ai.tool.call.id": functionCall.id ?? event.id,
        "gcp.vertex.agent.tool_call_args": safeJsonSerialize(functionCall.args ?? {}),
        "gcp.vertex.agent.subagent.name": stringValue((functionCall.args as { agentName?: unknown } | undefined)?.agentName) || metadataSubAgentName,
      });
    }
    if (functionResponse) {
      span.setAttributes({
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": functionResponse.name ?? "run_adk_subagent",
        "gen_ai.tool.call.id": functionResponse.id ?? event.id,
        "gcp.vertex.agent.tool_response": safeJsonSerialize(functionResponse.response ?? {}),
        "gcp.vertex.agent.subagent.name": stringValue((functionResponse.response as { agentName?: unknown } | undefined)?.agentName) || metadataSubAgentName,
      });
    }
  } finally {
    span.end();
  }
}

function buildSyntheticAdkLlmRequest(
  context: InvocationContext,
  providerId: string,
): { model: string; contents: Content[] } {
  const userContent = (context as { userContent?: Content }).userContent;
  return {
    model: providerId,
    contents: userContent ? [contentForTrace(userContent)] : [],
  };
}

function contentForTrace(content: Content): Content {
  return {
    role: content.role,
    parts: content.parts?.filter((part) => !part.inlineData) ?? [],
  };
}

function spanNameForEvent(event: Event): string {
  const functionCall = event.content?.parts?.find((part) => part.functionCall)?.functionCall;
  if (functionCall) {
    const subAgentName = stringValue((functionCall.args as { agentName?: unknown } | undefined)?.agentName);
    return functionCall.name === "run_adk_subagent" && subAgentName
      ? `execute_tool run_adk_subagent → ${subAgentName}`
      : `execute_tool ${functionCall.name ?? "<unknown>"}${toolDetail(functionCall.args)}`;
  }

  const functionResponse = event.content?.parts?.find((part) => part.functionResponse)?.functionResponse;
  if (functionResponse) {
    const subAgentName = stringValue((functionResponse.response as { agentName?: unknown } | undefined)?.agentName);
    return functionResponse.name === "run_adk_subagent" && subAgentName
      ? `execute_tool run_adk_subagent ← ${subAgentName}`
      : `execute_tool ${functionResponse.name ?? "<unknown>"}${toolDetail(functionResponse.response)}`;
  }

  const toolProgressSpanName = spanNameForToolProgress(event);
  if (toolProgressSpanName) {
    return toolProgressSpanName;
  }

  return "call_llm";
}

function spanNameForToolProgress(event: Event): string | undefined {
  const metadata = readCustomMetadata(event);
  const itemType = stringValue(metadata.itemType);
  if (!isToolProgressItemType(itemType)) {
    return undefined;
  }
  return `execute_tool ${itemType}${toolDetail(metadata)}`;
}

function isToolProgressItemType(value: string): boolean {
  return value === "command_execution" || value === "web_search" || value === "mcp_tool_call";
}

function toolDetail(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  const command = stringValue(record.command);
  const status = stringValue(record.status);
  const query = stringValue(record.query);
  const toolName = stringValue(record.toolName);
  const detail = command || query || toolName || status;
  return detail ? `: ${truncate(detail, 72)}` : "";
}

function readableEventTitle(event: Event): string {
  const metadata = readCustomMetadata(event);
  const metadataTitle = stringValue(metadata.title);
  if (metadataTitle) {
    return metadataTitle;
  }

  const functionCall = event.content?.parts?.find((part) => part.functionCall)?.functionCall;
  if (functionCall?.name) {
    return `functionCall:${functionCall.name}`;
  }

  const functionResponse = event.content?.parts?.find((part) => part.functionResponse)?.functionResponse;
  if (functionResponse?.name) {
    return `functionResponse:${functionResponse.name}`;
  }

  const text = event.content?.parts
    ?.map((part) => part.text)
    .find((part): part is string => typeof part === "string" && part.length > 0);
  if (text) {
    return truncate(text, 80);
  }

  const itemType = stringValue(metadata.itemType);
  const status = stringValue(metadata.status);
  const subAgentName = stringValue(metadata.subAgentName) || event.author;
  if (itemType && subAgentName) {
    return `${subAgentName}: ${itemType}${status ? ` ${status}` : ""}`;
  }

  return event.errorMessage ? `error:${event.errorCode ?? "EXTERNAL_AGENT_ERROR"}` : event.author ?? "external_agent";
}

function readCustomMetadata(event: Event): Record<string, unknown> {
  return (event as { customMetadata?: Record<string, unknown> }).customMetadata ?? {};
}

function readSessionId(context: InvocationContext): string {
  const session = (context as { session?: { id?: unknown } }).session;
  return typeof session?.id === "string" ? session.id : "";
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeJsonSerialize(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "<not serializable>";
  }
}
