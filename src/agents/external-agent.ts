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

export interface ExternalAgentConfig {
  name: string;
  description?: string;
  provider: ExternalAgentProviderDefinition;
  driver?: ExternalAgentDriver;
  credentialProvider?: ExternalAgentCredentialProvider;
  instruction?: string;
  workingDirectory?: string;
  permissions?: ExternalAgentPermissionPolicy;
}

export class ExternalAgent extends BaseAgent {
  readonly provider: ExternalAgentProviderDefinition;
  readonly driver: ExternalAgentDriver;
  readonly credentialProvider: ExternalAgentCredentialProvider;
  readonly instruction?: string;
  readonly workingDirectory?: string;
  readonly permissions?: ExternalAgentPermissionPolicy;

  constructor(config: ExternalAgentConfig) {
    super({ name: config.name, description: config.description });
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
  ): AsyncGenerator<ReturnType<typeof createEvent>, void, void> {
    const credential = await this.credentialProvider.getCredential({
      providerId: this.provider.id,
      envAllowlist: this.provider.envAllowlist,
    });

    for await (const event of this.driver.run({
      provider: this.provider,
      context,
      instruction: this.instruction,
      workingDirectory: this.workingDirectory,
      credential,
      permissions: this.permissions,
    })) {
      yield this.toAdkEvent(event);
    }
  }

  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<ReturnType<typeof createEvent>, void, void> {
    yield* this.runAsyncImpl(context);
  }

  protected toAdkEvent(event: ExternalAgentEvent): ReturnType<typeof createEvent> {
    return createEvent({
      author: this.name,
      content: this.eventToContent(event),
    });
  }

  private eventToContent(event: ExternalAgentEvent): Content {
    switch (event.type) {
      case "output":
        return { role: "model", parts: [{ text: event.content }] };
      case "error":
        return { role: "model", parts: [{ text: event.message }] };
      default:
        return { role: "model", parts: [{ text: JSON.stringify(event) }] };
    }
  }
}
