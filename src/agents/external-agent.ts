/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { BaseAgent, createEvent, type InvocationContext } from "@google/adk";
import type { Content } from "@google/genai";
import type { ExternalAgentCredentialProvider } from "./auth/credential-provider.js";
import { NoopCredentialProvider } from "./auth/credential-provider.js";
import type { ExternalAgentDriver } from "./external-agent-driver.js";
import { PlaceholderExternalAgentDriver } from "./external-agent-driver.js";
import type { ExternalAgentEvent } from "./events.js";
import type { ExternalAgentPermissionPolicy } from "./permissions/schema.js";
import type { ExternalAgentProviderDefinition } from "./provider/schema.js";
import { ToolGateway } from "./tools/tool-gateway.js";

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
  ): AsyncGenerator<ReturnType<typeof createEvent>, void, void> {
    const credential = await this.credentialProvider.getCredential({
      providerId: this.provider.id,
      envAllowlist: this.provider.envAllowlist,
    });
    const permissions = readPermissionOverride(context) ?? this.permissions;

    const rootAgent = this.rootAgent ?? context.agent ?? this;
    const subAgents = this.subAgents;
    const toolGateway = subAgents.length > 0
      ? new ToolGateway({
          rootAgent,
          subAgents,
          parentContext: context,
          parentPermissions: permissions,
        })
      : undefined;

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
        yield adkEvent;
      }
    }
  }

  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<ReturnType<typeof createEvent>, void, void> {
    yield* this.runAsyncImpl(context);
  }

  protected toAdkEvent(
    event: ExternalAgentEvent,
    context: InvocationContext,
  ): ReturnType<typeof createEvent> | undefined {
    switch (event.type) {
      case "output":
        return createEvent({
          invocationId: context.invocationId,
          author: this.name,
          branch: context.branch,
          content: { role: "model", parts: [{ text: event.content }] },
        });
      case "error":
        return createEvent({
          invocationId: context.invocationId,
          author: this.name,
          branch: context.branch,
          errorCode: event.code ?? "EXTERNAL_AGENT_ERROR",
          errorMessage: event.message,
        });
      case "tool_call":
        return createEvent({
          invocationId: context.invocationId,
          author: this.name,
          branch: context.branch,
          content: this.toolCallToContent(event),
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
            name: event.name,
            args: normalizeToolCallArgs(event.input),
          },
        },
      ],
    };
  }
}
