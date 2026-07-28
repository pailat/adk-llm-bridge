/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExternalAgentDefinitionRegistry } from "../../agents/agent-registry.js";
import type { ExternalAgentDefinitionConfig } from "../../agents/agent-schema.js";
import type { ExternalAgentPermissionPolicy } from "../../agents/permissions/schema.js";
import {
  DEFAULT_WORKFLOW_AGENT_FACTORY_LIMITS,
  type WorkflowAgentDescriptor,
  type WorkflowAgentFactory,
  WorkflowAgentFactoryError,
  type WorkflowAgentFactoryLimits,
  type WorkflowAgentFactoryRequest,
  type WorkflowAgentHandle,
  type WorkflowExternalAgentConfig,
} from "./workflow-agent-factory.js";

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const CONFIG_KEYS = new Set([
  "description",
  "instruction",
  "workingDirectory",
  "permissions",
]);
const PERMISSION_KEYS = new Set(["mode", "allowNetwork", "allowedPaths"]);
const POLICY_KEYS = new Set([
  "allowFullAccess",
  "allowNetwork",
  "workingDirectoryRoots",
]);
const PERMISSION_MODES = new Set([
  "read-only",
  "ask",
  "workspace-write",
  "full-access",
]);

export interface ExternalAgentWorkflowFactoryOptions {
  registry: ExternalAgentDefinitionRegistry;
  allowedProviderIds?: readonly string[];
  limits?: Partial<WorkflowAgentFactoryLimits>;
  policy?: WorkflowAgentPolicyCeilings;
}

/** Host-owned ceilings. Omitted capabilities are denied by default. */
export interface WorkflowAgentPolicyCeilings {
  allowFullAccess?: boolean;
  allowNetwork?: boolean;
  workingDirectoryRoots?: readonly string[];
}

interface NormalizedPolicyCeilings {
  allowFullAccess: boolean;
  allowNetwork: boolean;
  workingDirectoryRoots: readonly string[];
}

/** Host-controlled adapter over the external-agent definition registry. */
export class ExternalAgentWorkflowFactory implements WorkflowAgentFactory {
  readonly #registry: ExternalAgentDefinitionRegistry;
  readonly #allowedProviderIds?: ReadonlySet<string>;
  readonly #limits: Readonly<WorkflowAgentFactoryLimits>;
  readonly #policy: Readonly<NormalizedPolicyCeilings>;
  readonly #handles = new Map<string, WorkflowAgentHandle>();

  constructor(options: ExternalAgentWorkflowFactoryOptions) {
    if (!options?.registry) {
      invalid("Workflow agent factory requires an external-agent registry");
    }
    this.#registry = options.registry;
    this.#limits = normalizeLimits(options.limits);
    this.#policy = normalizePolicyCeilings(options.policy, this.#limits);
    this.#allowedProviderIds = normalizeProviderAllowlist(
      options.allowedProviderIds,
      this.#limits,
    );
  }

  create(request: WorkflowAgentFactoryRequest): WorkflowAgentHandle {
    const normalized = normalizeRequest(request, this.#limits, this.#policy);
    this.assertProviderAllowed(normalized.providerId);
    if (!this.#registry.has(normalized.providerId)) {
      throw new WorkflowAgentFactoryError(
        "WORKFLOW_AGENT_UNKNOWN_PROVIDER",
        `Unknown workflow agent provider: ${normalized.providerId}`,
        { providerId: normalized.providerId },
      );
    }
    if (this.#handles.has(normalized.name)) {
      throw new WorkflowAgentFactoryError(
        "WORKFLOW_AGENT_DUPLICATE_NAME",
        `Workflow agent name is already active: ${normalized.name}`,
        { name: normalized.name },
      );
    }
    if (this.#handles.size >= this.#limits.maxAgents) {
      throw new WorkflowAgentFactoryError(
        "WORKFLOW_AGENT_LIMIT_EXCEEDED",
        `Workflow agent factory exceeded the active limit of ${this.#limits.maxAgents}`,
        { limit: this.#limits.maxAgents },
      );
    }

    const descriptor = Object.freeze({
      providerId: normalized.providerId,
      name: normalized.name,
    });
    const agent = this.#registry.create(
      normalized.providerId,
      externalAgentConfig(normalized),
    );
    const handle = Object.freeze({ descriptor, agent });
    this.#handles.set(normalized.name, handle);
    return handle;
  }

  get(name: string): WorkflowAgentHandle | undefined {
    return this.#handles.get(name);
  }

  list(): readonly WorkflowAgentDescriptor[] {
    return Object.freeze(
      [...this.#handles.values()].map((handle) => handle.descriptor),
    );
  }

  release(handle: WorkflowAgentHandle): boolean {
    const active = this.#handles.get(handle.descriptor.name);
    if (active !== handle) return false;
    return this.#handles.delete(handle.descriptor.name);
  }

  private assertProviderAllowed(providerId: string): void {
    if (this.#allowedProviderIds && !this.#allowedProviderIds.has(providerId)) {
      throw new WorkflowAgentFactoryError(
        "WORKFLOW_AGENT_PROVIDER_NOT_ALLOWED",
        `Workflow agent provider is not allowed: ${providerId}`,
        { providerId },
      );
    }
  }
}

function normalizeRequest(
  request: WorkflowAgentFactoryRequest,
  limits: WorkflowAgentFactoryLimits,
  policy: NormalizedPolicyCeilings,
): WorkflowAgentFactoryRequest {
  if (!isRecord(request)) invalid("Workflow agent request must be an object");
  assertOnlyKeys(request, new Set(["providerId", "name", "config"]), "request");

  const providerId = safeString(
    request.providerId,
    "providerId",
    limits.maxProviderIdLength,
    SAFE_PROVIDER_ID,
  );
  const name = safeString(
    request.name,
    "name",
    limits.maxNameLength,
    SAFE_IDENTIFIER,
  );
  const config = normalizeConfig(request.config, limits, policy);
  return Object.freeze({ providerId, name, ...(config ? { config } : {}) });
}

function normalizeConfig(
  config: WorkflowExternalAgentConfig | undefined,
  limits: WorkflowAgentFactoryLimits,
  policy: NormalizedPolicyCeilings,
): WorkflowExternalAgentConfig | undefined {
  if (config === undefined) return undefined;
  if (!isRecord(config)) invalid("Workflow agent config must be an object");
  assertOnlyKeys(config, CONFIG_KEYS, "config");

  const description = optionalString(
    config.description,
    "description",
    limits.maxDescriptionLength,
  );
  const instruction = optionalString(
    config.instruction,
    "instruction",
    limits.maxInstructionLength,
  );
  const workingDirectory = normalizeWorkingDirectory(
    config.workingDirectory,
    limits,
    policy,
  );
  const permissions = normalizePermissions(
    config.permissions,
    limits,
    policy,
    workingDirectory,
  );
  assertPermissionsWithinPolicy(permissions, policy);
  return Object.freeze({
    ...(description !== undefined ? { description } : {}),
    ...(instruction !== undefined ? { instruction } : {}),
    ...(workingDirectory !== undefined ? { workingDirectory } : {}),
    ...(permissions ? { permissions } : {}),
  });
}

function normalizeWorkingDirectory(
  workingDirectory: unknown,
  limits: WorkflowAgentFactoryLimits,
  policy: NormalizedPolicyCeilings,
): string | undefined {
  if (workingDirectory === undefined) return undefined;
  const requested = safeString(
    workingDirectory,
    "workingDirectory",
    limits.maxWorkingDirectoryLength,
  );
  if (!isAbsolute(requested)) {
    policyExceeded("Workflow agent workingDirectory must be absolute");
  }
  if (policy.workingDirectoryRoots.length === 0) {
    policyExceeded(
      "Workflow agent workingDirectory requires host-configured roots",
    );
  }

  const normalized = resolve(requested);
  if (
    !policy.workingDirectoryRoots.some((root) => isPathWithin(root, normalized))
  ) {
    policyExceeded(
      `Workflow agent workingDirectory is outside host-configured roots: ${requested}`,
    );
  }
  return normalized;
}

function assertPermissionsWithinPolicy(
  permissions: ExternalAgentPermissionPolicy | undefined,
  policy: NormalizedPolicyCeilings,
): void {
  if (permissions?.mode === "full-access" && !policy.allowFullAccess) {
    policyExceeded("Workflow agent full-access requires explicit host opt-in");
  }
  if (permissions?.allowNetwork === true && !policy.allowNetwork) {
    policyExceeded(
      "Workflow agent network access requires explicit host opt-in",
    );
  }
}

function normalizePermissions(
  permissions: unknown,
  limits: WorkflowAgentFactoryLimits,
  policy: NormalizedPolicyCeilings,
  workingDirectory: string | undefined,
): ExternalAgentPermissionPolicy | undefined {
  if (permissions === undefined) return undefined;
  if (!isRecord(permissions)) {
    invalid("Workflow agent permissions must be an object");
  }
  assertOnlyKeys(permissions, PERMISSION_KEYS, "permissions");
  if (
    typeof permissions.mode !== "string" ||
    !PERMISSION_MODES.has(permissions.mode)
  ) {
    invalid("Workflow agent permission mode is invalid");
  }
  if (
    permissions.allowNetwork !== undefined &&
    typeof permissions.allowNetwork !== "boolean"
  ) {
    invalid("Workflow agent allowNetwork must be boolean");
  }

  let allowedPaths: readonly string[] | undefined;
  if (permissions.allowedPaths !== undefined) {
    if (!Array.isArray(permissions.allowedPaths)) {
      invalid("Workflow agent allowedPaths must be an array");
    }
    if (permissions.allowedPaths.length > limits.maxAllowedPaths) {
      invalid(
        `Workflow agent allowedPaths exceeds ${limits.maxAllowedPaths} entries`,
      );
    }
    if (policy.workingDirectoryRoots.length === 0) {
      policyExceeded(
        "Workflow agent allowedPaths requires host-configured workingDirectory roots",
      );
    }
    allowedPaths = Object.freeze(
      [
        ...new Set(
          permissions.allowedPaths.map((path, index) =>
            normalizeAllowedPath(path, index, limits, policy, workingDirectory),
          ),
        ),
      ].sort(),
    );
  }
  return Object.freeze({
    mode: permissions.mode as ExternalAgentPermissionPolicy["mode"],
    ...(permissions.allowNetwork !== undefined
      ? { allowNetwork: permissions.allowNetwork }
      : {}),
    ...(allowedPaths ? { allowedPaths } : {}),
  });
}

function normalizeAllowedPath(
  path: unknown,
  index: number,
  limits: WorkflowAgentFactoryLimits,
  policy: NormalizedPolicyCeilings,
  workingDirectory: string | undefined,
): string {
  const requested = safeString(
    path,
    `allowedPaths[${index}]`,
    limits.maxAllowedPathLength,
  );
  if (!isAbsolute(requested) && !workingDirectory) {
    policyExceeded(
      "Workflow agent relative allowedPaths requires an authorized workingDirectory",
    );
  }

  const normalized = isAbsolute(requested)
    ? resolve(requested)
    : resolve(workingDirectory as string, requested);
  if (
    !policy.workingDirectoryRoots.some((root) => isPathWithin(root, normalized))
  ) {
    policyExceeded(
      `Workflow agent allowedPath is outside host-configured roots: ${requested}`,
    );
  }
  return normalized;
}

function externalAgentConfig(
  request: WorkflowAgentFactoryRequest,
): ExternalAgentDefinitionConfig {
  return {
    name: request.name,
    ...(request.config?.description !== undefined
      ? { description: request.config.description }
      : {}),
    ...(request.config?.instruction !== undefined
      ? { instruction: request.config.instruction }
      : {}),
    ...(request.config?.workingDirectory !== undefined
      ? { workingDirectory: request.config.workingDirectory }
      : {}),
    ...(request.config?.permissions
      ? { permissions: request.config.permissions }
      : {}),
  };
}

function normalizeProviderAllowlist(
  providerIds: readonly string[] | undefined,
  limits: WorkflowAgentFactoryLimits,
): ReadonlySet<string> | undefined {
  if (providerIds === undefined) return undefined;
  if (!Array.isArray(providerIds)) {
    invalid("Workflow agent provider allowlist must be an array");
  }
  return new Set(
    providerIds.map((providerId) =>
      safeString(
        providerId,
        "allowedProviderId",
        limits.maxProviderIdLength,
        SAFE_PROVIDER_ID,
      ),
    ),
  );
}

function normalizePolicyCeilings(
  policy: WorkflowAgentPolicyCeilings | undefined,
  limits: WorkflowAgentFactoryLimits,
): Readonly<NormalizedPolicyCeilings> {
  if (policy === undefined) {
    return Object.freeze({
      allowFullAccess: false,
      allowNetwork: false,
      workingDirectoryRoots: Object.freeze([]),
    });
  }
  if (!isRecord(policy)) {
    invalid("Workflow agent policy ceilings must be an object");
  }
  assertOnlyKeys(policy, POLICY_KEYS, "policy ceilings");
  if (
    policy.allowFullAccess !== undefined &&
    typeof policy.allowFullAccess !== "boolean"
  ) {
    invalid("Workflow agent allowFullAccess ceiling must be boolean");
  }
  if (
    policy.allowNetwork !== undefined &&
    typeof policy.allowNetwork !== "boolean"
  ) {
    invalid("Workflow agent allowNetwork ceiling must be boolean");
  }
  if (
    policy.workingDirectoryRoots !== undefined &&
    !Array.isArray(policy.workingDirectoryRoots)
  ) {
    invalid("Workflow agent workingDirectoryRoots must be an array");
  }

  const roots = (policy.workingDirectoryRoots ?? []).map((root, index) => {
    const candidate = safeString(
      root,
      `workingDirectoryRoots[${index}]`,
      limits.maxWorkingDirectoryLength,
    );
    if (!isAbsolute(candidate)) {
      invalid("Workflow agent workingDirectoryRoots must be absolute");
    }
    return resolve(candidate);
  });
  return Object.freeze({
    allowFullAccess: policy.allowFullAccess ?? false,
    allowNetwork: policy.allowNetwork ?? false,
    workingDirectoryRoots: Object.freeze([...new Set(roots)].sort()),
  });
}

function normalizeLimits(
  limits: Partial<WorkflowAgentFactoryLimits> | undefined,
): Readonly<WorkflowAgentFactoryLimits> {
  if (limits !== undefined && !isRecord(limits)) {
    invalid("Workflow agent factory limits must be an object");
  }
  const normalized = {
    ...DEFAULT_WORKFLOW_AGENT_FACTORY_LIMITS,
    ...(limits ?? {}),
  };
  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      invalid(
        `Workflow agent factory limit ${name} must be a positive integer`,
      );
    }
  }
  return Object.freeze(normalized);
}

function optionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  return safeString(value, field, maxLength);
}

function safeString(
  value: unknown,
  field: string,
  maxLength: number,
  pattern?: RegExp,
): string {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    invalid(`Workflow agent ${field} must be a non-empty trimmed string`);
  }
  if (value.includes("\0")) {
    invalid(`Workflow agent ${field} must not contain NUL bytes`);
  }
  if (value.length > maxLength) {
    invalid(`Workflow agent ${field} exceeds ${maxLength} characters`);
  }
  if (pattern && !pattern.test(value)) {
    invalid(`Workflow agent ${field} contains unsafe characters`);
  }
  return value;
}

function isPathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  const unknown = Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort();
  if (unknown.length > 0) {
    invalid(
      `Workflow agent ${field} contains unknown fields: ${unknown.join(", ")}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(message: string): never {
  throw new WorkflowAgentFactoryError(
    "WORKFLOW_AGENT_INVALID_REQUEST",
    message,
  );
}

function policyExceeded(message: string): never {
  throw new WorkflowAgentFactoryError(
    "WORKFLOW_AGENT_POLICY_EXCEEDED",
    message,
  );
}
