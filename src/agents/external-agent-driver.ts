/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { BaseAgent, BaseTool, InvocationContext } from "@google/adk";
import type { ExternalAgentCredential } from "./auth/schema.js";
import type { ExternalAgentEvent } from "./events.js";
import type { ExternalAgentPermissionPolicy } from "./permissions/schema.js";
import type { ExternalAgentProviderDefinition } from "./provider/schema.js";
import type { AgentRuntimeCapabilities } from "./runtime/capabilities.js";
import type { AgentRuntimeSession } from "./runtime/runtime-session.js";
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
  runtimeSession?: AgentRuntimeSession;
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
