/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { BaseAgent } from "@google/adk";
import type { ExternalAgentPermissionPolicy } from "../../agents/permissions/schema.js";

export const DEFAULT_WORKFLOW_AGENT_FACTORY_LIMITS = Object.freeze({
  maxAgents: 16,
  maxNameLength: 64,
  maxProviderIdLength: 64,
  maxDescriptionLength: 1_024,
  maxInstructionLength: 100_000,
  maxWorkingDirectoryLength: 4_096,
  maxAllowedPaths: 128,
  maxAllowedPathLength: 4_096,
});

export interface WorkflowAgentFactoryLimits {
  maxAgents: number;
  maxNameLength: number;
  maxProviderIdLength: number;
  maxDescriptionLength: number;
  maxInstructionLength: number;
  maxWorkingDirectoryLength: number;
  maxAllowedPaths: number;
  maxAllowedPathLength: number;
}

/** JSON-safe provider configuration accepted by the host-side factory. */
export interface WorkflowExternalAgentConfig {
  description?: string;
  instruction?: string;
  workingDirectory?: string;
  permissions?: ExternalAgentPermissionPolicy;
}

export interface WorkflowAgentFactoryRequest {
  providerId: string;
  name: string;
  config?: WorkflowExternalAgentConfig;
}

/** Secret-free metadata that may be logged or projected by a host. */
export interface WorkflowAgentDescriptor {
  providerId: string;
  name: string;
  /** Secret-free deterministic fingerprint of the effective agent config. */
  revision: string;
}

/** Host-only handle. The BaseAgent must never be serialized into a guest VM. */
export interface WorkflowAgentHandle {
  descriptor: WorkflowAgentDescriptor;
  agent: BaseAgent;
}

export interface WorkflowAgentFactory {
  create(
    request: WorkflowAgentFactoryRequest,
  ): WorkflowAgentHandle | Promise<WorkflowAgentHandle>;
  get(name: string): WorkflowAgentHandle | undefined;
  list(): readonly WorkflowAgentDescriptor[];
  release(handle: WorkflowAgentHandle): boolean | Promise<boolean>;
}

export type WorkflowAgentFactoryErrorCode =
  | "WORKFLOW_AGENT_INVALID_REQUEST"
  | "WORKFLOW_AGENT_PROVIDER_NOT_ALLOWED"
  | "WORKFLOW_AGENT_UNKNOWN_PROVIDER"
  | "WORKFLOW_AGENT_POLICY_EXCEEDED"
  | "WORKFLOW_AGENT_DUPLICATE_NAME"
  | "WORKFLOW_AGENT_LIMIT_EXCEEDED";

export class WorkflowAgentFactoryError extends Error {
  readonly code: WorkflowAgentFactoryErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: WorkflowAgentFactoryErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "WorkflowAgentFactoryError";
    this.code = code;
    this.details = details;
  }
}
