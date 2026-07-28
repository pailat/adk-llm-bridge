/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { randomUUID } from "node:crypto";
import {
  optionalJsonObject,
  requiredResourceIdentity,
  type WorkflowResourceJsonObject,
} from "./json.js";

export interface WorkspaceProvisionRequest {
  executionId: string;
  taskId: string;
  parameters?: WorkflowResourceJsonObject;
}

/** JSON-safe identity suitable for checkpoints, events, and agent context. */
export interface WorkspaceDescriptor {
  workspaceId: string;
  providerId: string;
  executionId: string;
  taskId: string;
  revision: string;
  parameters: WorkflowResourceJsonObject;
}

export interface WorkspaceProvisionOptions {
  signal?: AbortSignal;
}

/**
 * Host-only capability. Only `descriptor` may cross a sandbox or checkpoint;
 * `host` and `release` remain in the trusted host process.
 */
export interface ProvisionedWorkspace<HostResource = unknown> {
  readonly descriptor: WorkspaceDescriptor;
  readonly host: HostResource;
  release(): Promise<boolean>;
}

export interface WorkspaceProvisioner<HostResource = unknown> {
  provision(
    request: WorkspaceProvisionRequest,
    options?: WorkspaceProvisionOptions,
  ): Promise<ProvisionedWorkspace<HostResource>>;
}

export interface InMemoryWorkspaceResource {
  readonly kind: "memory";
  readonly workspaceId: string;
}

export interface InMemoryWorkspaceProvisionerOptions {
  providerId?: string;
  createWorkspaceId?: () => string;
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

  constructor(options: InMemoryWorkspaceProvisionerOptions = {}) {
    this.#providerId = requiredResourceIdentity(
      options.providerId ?? "memory",
      "providerId",
    );
    this.#createWorkspaceId = options.createWorkspaceId ?? randomUUID;
    this.#createRevision = options.createRevision ?? randomUUID;
  }

  async provision(
    request: WorkspaceProvisionRequest,
    options: WorkspaceProvisionOptions = {},
  ): Promise<ProvisionedWorkspace<InMemoryWorkspaceResource>> {
    throwIfAborted(options.signal);
    const descriptor: WorkspaceDescriptor = Object.freeze({
      workspaceId: requiredResourceIdentity(
        this.#createWorkspaceId(),
        "workspaceId",
      ),
      providerId: this.#providerId,
      executionId: requiredResourceIdentity(request.executionId, "executionId"),
      taskId: requiredResourceIdentity(request.taskId, "taskId"),
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

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error("Workspace provisioning aborted");
}
