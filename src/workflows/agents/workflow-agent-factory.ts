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
  /**
   * Model id the agent must run.
   *
   * @remarks
   * Forwarded to the provider's driver as the `model` option, checked with the
   * driver's model grammar, and recorded in the descriptor. It is not part of the revision: a model
   * change is reported by the replay model check (`replay.modelChange`).
   * The factory fails closed when the driver does not keep exactly this id
   * (`WORKFLOW_AGENT_MODEL_NOT_APPLIED`), so a custom definition that turns an
   * alias into a full id must be given the id the driver keeps. With
   * `config.model`, the definition's `createDriver` receives `{ model }` (and
   * `requireExplicitModel` when the factory has it) where it received no
   * options before: a custom definition must merge these into its own
   * defaults, not use them instead, or it loses those defaults.
   */
  model?: string;
  /**
   * Model id of the runtime's small/fast model (Claude Code's helper calls).
   *
   * @remarks
   * Forwarded to the driver as the `smallFastModel` option, checked with the
   * same grammar as `model`. Unlike `model` it is part of the revision when
   * given: a request without it keeps its earlier digest. Under the factory's
   * `requireExplicitModel`, the built-in `claude` provider id needs it
   * (`WORKFLOW_AGENT_MODEL_REQUIRED`) and the driver must keep exactly that
   * id (`WORKFLOW_AGENT_MODEL_NOT_APPLIED`). The run spec has no field for it:
   * the host maps its spec to `smallFastModel` itself.
   */
  smallFastModel?: string;
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
  /** The requested model id; absent when the request named none. */
  model?: string;
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
  | "WORKFLOW_AGENT_LIMIT_EXCEEDED"
  | "WORKFLOW_AGENT_MODEL_REQUIRED"
  | "WORKFLOW_AGENT_MODEL_NOT_APPLIED";

/**
 * Error thrown by workflow agent factories; branch on `code`.
 *
 * @remarks
 * `WORKFLOW_AGENT_MODEL_REQUIRED`: the factory has `requireExplicitModel`
 * and the request has no model, names a router or default alias of a built-in
 * provider, or the driver reports no model or refuses the alias (the driver's
 * error is the `cause`). `WORKFLOW_AGENT_MODEL_NOT_APPLIED`: the request has a
 * model and the driver does not keep exactly that id, or the definition cannot
 * take driver options. Nothing is registered in either case.
 */
export class WorkflowAgentFactoryError extends Error {
  /** Stable error code to branch on. */
  readonly code: WorkflowAgentFactoryErrorCode;
  /** Context for the failure, such as the provider id or the limit. */
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: WorkflowAgentFactoryErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "WorkflowAgentFactoryError";
    this.code = code;
    this.details = details;
  }
}
