import type { BaseAgent } from "@google/adk";
import type { ExternalAgentPermissionPolicy } from "../../agents/permissions/schema.js";

/**
 * Default {@link WorkflowAgentFactoryLimits} applied by the external-agent factory.
 */
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

/**
 * Size bounds on the agents a factory creates and the config it accepts.
 *
 * @remarks
 * The factory rejects a request above any bound with
 * `WORKFLOW_AGENT_LIMIT_EXCEEDED` or `WORKFLOW_AGENT_INVALID_REQUEST`.
 */
export interface WorkflowAgentFactoryLimits {
  /** Maximum number of agents active at once. */
  maxAgents: number;
  /** Maximum length of an agent name, in characters. */
  maxNameLength: number;
  /** Maximum length of a provider id, in characters. */
  maxProviderIdLength: number;
  /** Maximum length of an agent description, in characters. */
  maxDescriptionLength: number;
  /** Maximum length of an agent instruction, in characters. */
  maxInstructionLength: number;
  /** Maximum length of a working directory path, in characters. */
  maxWorkingDirectoryLength: number;
  /** Maximum number of entries in `permissions.allowedPaths`. */
  maxAllowedPaths: number;
  /** Maximum length of one allowed path, in characters. */
  maxAllowedPathLength: number;
}

/** JSON-safe provider configuration accepted by the host-side factory. */
export interface WorkflowExternalAgentConfig {
  /** Agent description. */
  description?: string;
  /** System instruction for the agent. */
  instruction?: string;
  /** Absolute working directory; must lie inside a host-configured root. */
  workingDirectory?: string;
  /** Requested permission policy; must stay within the host's policy ceilings. */
  permissions?: ExternalAgentPermissionPolicy;
}

/** Request to create a named agent for a registered provider. */
export interface WorkflowAgentFactoryRequest {
  /** Registered external-agent provider id. */
  providerId: string;
  /** Agent name, a safe identifier unique among active agents. */
  name: string;
  /** Optional provider configuration. */
  config?: WorkflowExternalAgentConfig;
}

/** Secret-free metadata that may be logged or projected by a host. */
export interface WorkflowAgentDescriptor {
  /** Provider the agent was created for. */
  providerId: string;
  /** Agent name. */
  name: string;
  /** Secret-free deterministic fingerprint of the effective agent config. */
  revision: string;
}

/** Host-only handle. The BaseAgent must never be serialized into a guest VM. */
export interface WorkflowAgentHandle {
  /** Secret-free metadata describing the agent. */
  descriptor: WorkflowAgentDescriptor;
  /** The live ADK agent; host-only. */
  agent: BaseAgent;
}

/**
 * Host-side factory of the agents a workflow script may use.
 *
 * @remarks
 * Guest code only sees descriptors; the `BaseAgent` stays in the host.
 */
export interface WorkflowAgentFactory {
  /**
   * Creates and registers a named agent.
   *
   * @param request - Provider, name and optional configuration.
   * @returns A handle holding the agent and its descriptor.
   * @throws {@link WorkflowAgentFactoryError} when the request is rejected.
   */
  create(
    request: WorkflowAgentFactoryRequest,
  ): WorkflowAgentHandle | Promise<WorkflowAgentHandle>;
  /**
   * Looks up an active agent by name.
   *
   * @param name - Agent name.
   * @returns The handle, or `undefined` when no such agent is active.
   */
  get(name: string): WorkflowAgentHandle | undefined;
  /** Lists the descriptors of all active agents. */
  list(): readonly WorkflowAgentDescriptor[];
  /**
   * Releases an agent so its name and capacity slot can be reused.
   *
   * @param handle - Handle returned by `create`.
   * @returns `true` when the handle was active and is now released.
   */
  release(handle: WorkflowAgentHandle): boolean | Promise<boolean>;
}

/** Error codes thrown by {@link WorkflowAgentFactory} implementations. */
export type WorkflowAgentFactoryErrorCode =
  | "WORKFLOW_AGENT_INVALID_REQUEST"
  | "WORKFLOW_AGENT_PROVIDER_NOT_ALLOWED"
  | "WORKFLOW_AGENT_UNKNOWN_PROVIDER"
  | "WORKFLOW_AGENT_POLICY_EXCEEDED"
  | "WORKFLOW_AGENT_DUPLICATE_NAME"
  | "WORKFLOW_AGENT_LIMIT_EXCEEDED";

/** Error thrown by workflow agent factories; branch on `code`. */
export class WorkflowAgentFactoryError extends Error {
  /** Stable error code to branch on. */
  readonly code: WorkflowAgentFactoryErrorCode;
  /** Context for the failure, such as the provider id or the limit. */
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
