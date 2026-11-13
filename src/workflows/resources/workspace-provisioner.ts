import { randomUUID } from "node:crypto";
import { throwIfAborted } from "../internal/abort.js";
import { isWorkflowIdentifier } from "../internal/identifiers.js";
import {
  optionalJsonObject,
  requiredResourceIdentity,
  type WorkflowResourceJsonObject,
} from "./json.js";

const ABORTED = "Workspace provisioning aborted";

/** Request to provision a workspace. */
export interface WorkspaceProvisionRequest {
  /** Execution the workspace belongs to. */
  executionId: string;
  /** Task the workspace is for. */
  taskId: string;
  /**
   * Provider-specific JSON parameters.
   *
   * @defaultValue `{}`
   */
  parameters?: WorkflowResourceJsonObject;
}

/** JSON-safe identity suitable for checkpoints, events, and agent context. */
export interface WorkspaceDescriptor {
  /** Workspace identity. */
  workspaceId: string;
  /** Provisioner that created the workspace. */
  providerId: string;
  /** Owning execution. */
  executionId: string;
  /** Owning task. */
  taskId: string;
  /** Revision of this provisioning. */
  revision: string;
  /** Frozen copy of the request parameters. */
  parameters: WorkflowResourceJsonObject;
}

/** Options for {@link WorkspaceProvisioner.provision}. */
export interface WorkspaceProvisionOptions {
  /** Optional abort signal. */
  signal?: AbortSignal;
}

/**
 * Host-only capability. Only `descriptor` may cross a sandbox or checkpoint;
 * `host` and `release` remain in the trusted host process.
 */
export interface ProvisionedWorkspace<HostResource = unknown> {
  /** JSON-safe identity that may be checkpointed or shown to agents. */
  readonly descriptor: WorkspaceDescriptor;
  /** Trusted host resource; never serialized. */
  readonly host: HostResource;
  /**
   * Releases the workspace.
   *
   * @returns `true` on the first release, `false` when already released.
   */
  release(): Promise<boolean>;
}

/** Port that creates workspaces for tasks. */
export interface WorkspaceProvisioner<HostResource = unknown> {
  /**
   * Provisions a workspace.
   *
   * @param request - Execution, task and parameters.
   * @param options - Optional abort signal.
   * @returns The provisioned workspace, which the caller must release.
   */
  provision(
    request: WorkspaceProvisionRequest,
    options?: WorkspaceProvisionOptions,
  ): Promise<ProvisionedWorkspace<HostResource>>;
}

/** Host resource of {@link InMemoryWorkspaceProvisioner}. */
export interface InMemoryWorkspaceResource {
  /** Constant discriminator. */
  readonly kind: "memory";
  /** Workspace identity. */
  readonly workspaceId: string;
}

/** Options for {@link InMemoryWorkspaceProvisioner}. */
export interface InMemoryWorkspaceProvisionerOptions {
  /**
   * Provider identity recorded in descriptors.
   *
   * @defaultValue `"memory"`
   */
  providerId?: string;
  /**
   * Generates workspace ids; must return safe, unique identities.
   *
   * @defaultValue `randomUUID`
   */
  createWorkspaceId?: () => string;
  /**
   * Generates revisions; must return safe identities.
   *
   * @defaultValue `randomUUID`
   */
  createRevision?: () => string;
}

/** Safe process-local provisioner for tests and development. */
export class InMemoryWorkspaceProvisioner
  implements WorkspaceProvisioner<InMemoryWorkspaceResource>
{
  readonly #providerId: string;
  readonly #createWorkspaceId: () => string;
  readonly #createRevision: () => string;
  readonly #active = new Set<string>();

  /**
   * Creates an in-memory workspace provisioner.
   *
   * @param options - Provider id and id generators.
   * @throws `TypeError` when `providerId` is not a safe identity.
   */
  constructor(options: InMemoryWorkspaceProvisionerOptions = {}) {
    this.#providerId = requiredResourceIdentity(
      options.providerId ?? "memory",
      "providerId",
    );
    this.#createWorkspaceId = options.createWorkspaceId ?? randomUUID;
    this.#createRevision = options.createRevision ?? randomUUID;
  }

  /**
   * Provisions an in-memory workspace.
   *
   * @param request - Execution, task and parameters.
   * @param options - Optional abort signal.
   * @returns A workspace whose `release` is idempotent.
   * @throws `TypeError` when the execution or task id is not a workflow
   * record id, or another identity or the parameters are unsafe.
   * @throws `Error` when the generated workspace id is already active.
   * @throws The signal's reason when `options.signal` is already aborted.
   */
  async provision(
    request: WorkspaceProvisionRequest,
    options: WorkspaceProvisionOptions = {},
  ): Promise<ProvisionedWorkspace<InMemoryWorkspaceResource>> {
    throwIfAborted(options.signal, ABORTED);
    const descriptor: WorkspaceDescriptor = Object.freeze({
      workspaceId: requiredResourceIdentity(
        this.#createWorkspaceId(),
        "workspaceId",
      ),
      providerId: this.#providerId,
      executionId: requiredRecordId(request.executionId, "executionId"),
      taskId: requiredRecordId(request.taskId, "taskId"),
      revision: requiredResourceIdentity(this.#createRevision(), "revision"),
      parameters: optionalJsonObject(request.parameters, "parameters"),
    });
    if (this.#active.has(descriptor.workspaceId)) {
      throw new Error(
        `Workspace identity is already active: ${descriptor.workspaceId}`,
      );
    }
    this.#active.add(descriptor.workspaceId);
    let released = false;
    const host: InMemoryWorkspaceResource = Object.freeze({
      kind: "memory",
      workspaceId: descriptor.workspaceId,
    });
    return Object.freeze({
      descriptor,
      host,
      release: async () => {
        if (released) return false;
        released = true;
        this.#active.delete(descriptor.workspaceId);
        return true;
      },
    });
  }
}

/** Execution and task ids follow the record grammar of every workflow store. */
function requiredRecordId(value: string, field: string): string {
  if (!isWorkflowIdentifier(value, "record")) {
    throw new TypeError(`${field} must be a workflow record id`);
  }
  return value;
}
