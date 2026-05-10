/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { InvocationContext } from "@google/adk";
import type { ExternalAgentCredential } from "./auth/schema";
import type { ExternalAgentEvent } from "./events";
import type { ExternalAgentPermissionPolicy } from "./permissions/schema";
import type { ExternalAgentProviderDefinition } from "./provider/schema";

export interface ExternalAgentRunRequest {
  provider: ExternalAgentProviderDefinition;
  context: InvocationContext;
  instruction?: string;
  workingDirectory?: string;
  credential?: ExternalAgentCredential;
  permissions?: ExternalAgentPermissionPolicy;
}

export interface ExternalAgentDriver {
  readonly providerId: string;
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
