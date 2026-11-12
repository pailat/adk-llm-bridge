import { isAbsolute, resolve } from "node:path";
import type { ExternalAgentDefinitionRegistry } from "../../agents/agent-registry.js";
import type { ExternalAgentDefinitionConfig } from "../../agents/agent-schema.js";
import {
  isModelId,
  isRouterAlias,
  MODEL_ALIAS_DENYLIST,
} from "../../agents/driver/model.js";
import {
  EXTERNAL_AGENT_MODEL_REQUIRED,
  ExternalAgentPolicyError,
} from "../../agents/driver/policy-errors.js";
import type { ExternalAgent } from "../../agents/external-agent.js";
import { canonicalPath, isUnderAny } from "../../agents/permissions/paths.js";
import type { ExternalAgentPermissionPolicy } from "../../agents/permissions/schema.js";
import { rememberLegacyDigest } from "../internal/canonical-hash.js";
import {
  canonicalDigestSync,
  legacyDigestSync,
} from "../internal/canonical-hash-node.js";
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
  "model",
  "smallFastModel",
]);
const PERMISSION_KEYS = new Set(["mode", "allowNetwork", "allowedPaths"]);
const FACTORY_OPTION_KEYS = new Set([
  "registry",
  "allowedProviderIds",
  "limits",
  "policy",
  "requireExplicitModel",
]);
const LIMIT_KEYS = new Set(Object.keys(DEFAULT_WORKFLOW_AGENT_FACTORY_LIMITS));
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

/**
 * Dependencies and options for {@link ExternalAgentWorkflowFactory}.
 *
 * @remarks
 * Omit `allowedProviderIds` to allow every provider in the registry. Omitted
 * `limits` fall back to {@link DEFAULT_WORKFLOW_AGENT_FACTORY_LIMITS}.
 */
export interface ExternalAgentWorkflowFactoryOptions {
  /** Registry that creates the external agents. */
  registry: ExternalAgentDefinitionRegistry;
  /** Provider ids a workflow may use; omit to allow every provider in the registry. */
  allowedProviderIds?: readonly string[];
  /** Overrides for the default size bounds; each must be a positive integer. */
  limits?: Partial<WorkflowAgentFactoryLimits>;
  /** Host ceilings for capabilities a workflow may request. */
  policy?: WorkflowAgentPolicyCeilings;
  /**
   * Refuse an agent without an explicit model.
   *
   * @remarks
   * A request without `config.model` fails with
   * `WORKFLOW_AGENT_MODEL_REQUIRED`, and so does a router or default alias of
   * a built-in provider id (`claude`: `default`, `best`, `opusplan`), which the factory checks itself. The
   * option is also forwarded to the driver. For a custom provider id the
   * factory cannot know the aliases: it relies on the driver refusing them,
   * and on the driver reporting a `model`.
   *
   * @defaultValue false
   */
  requireExplicitModel?: boolean;
}

/** Host-owned ceilings. Omitted capabilities are denied by default. */
export interface WorkflowAgentPolicyCeilings {
  /**
   * Whether agents may request the `full-access` permission mode.
   *
   * @defaultValue false
   */
  allowFullAccess?: boolean;
  /**
   * Whether agents may request network access.
   *
   * @defaultValue false
   */
  allowNetwork?: boolean;
  /**
   * Absolute directories that agent working directories and allowed paths
   * must lie within; when empty, working directories and allowed paths are
   * rejected. Containment is checked on real paths (symlinks resolved on both
   * sides, dangling links followed), so a symlink inside a root that points
   * outside it is rejected.
   */
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
  readonly #requireExplicitModel: boolean;
  readonly #handles = new Map<string, WorkflowAgentHandle>();

  /**
   * @param options - Registry, provider allowlist, limits, policy ceilings and model requirement.
   * @throws {@link WorkflowAgentFactoryError} with code `WORKFLOW_AGENT_INVALID_REQUEST`
   * when the registry is missing, an option, a `limits` key or a `policy` key is unknown
   * (the message names it; ceilings such as `allowFullAccess` go under `policy`),
   * or a value is malformed.
   */
  constructor(options: ExternalAgentWorkflowFactoryOptions) {
    if (!options?.registry) {
      invalid("Workflow agent factory requires an external-agent registry");
    }
    assertOnlyKeys(
      options as unknown as Record<string, unknown>,
      FACTORY_OPTION_KEYS,
      "factory options",
    );
    this.#registry = options.registry;
    this.#limits = normalizeLimits(options.limits);
    this.#policy = normalizePolicyCeilings(options.policy, this.#limits);
    if (
      options.requireExplicitModel !== undefined &&
      typeof options.requireExplicitModel !== "boolean"
    ) {
      invalid("Workflow agent requireExplicitModel must be boolean");
    }
    this.#requireExplicitModel = options.requireExplicitModel === true;
    this.#allowedProviderIds = normalizeProviderAllowlist(
      options.allowedProviderIds,
      this.#limits,
    );
  }

  /**
   * Creates an agent from the registry after validating the request against limits and policy.
   *
   * @param request - Provider, name and optional configuration.
   * @returns A frozen handle for the new agent.
   * @throws {@link WorkflowAgentFactoryError} with code `WORKFLOW_AGENT_INVALID_REQUEST`
   * for a malformed request, `WORKFLOW_AGENT_POLICY_EXCEEDED` when the request
   * exceeds the host ceilings, `WORKFLOW_AGENT_PROVIDER_NOT_ALLOWED` or
   * `WORKFLOW_AGENT_UNKNOWN_PROVIDER` for the provider, `WORKFLOW_AGENT_DUPLICATE_NAME`
   * when the name is active, `WORKFLOW_AGENT_LIMIT_EXCEEDED` when `maxAgents`
   * agents are active, `WORKFLOW_AGENT_MODEL_REQUIRED` under
   * `requireExplicitModel` when no usable model is set, and
   * `WORKFLOW_AGENT_MODEL_NOT_APPLIED` when `config.model` is given and the
   * driver does not keep exactly that id.
   */
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

    const model = normalized.config?.model;
    this.assertModelAllowed(normalized.providerId, model);
    this.assertSmallFastModelAllowed(
      normalized.providerId,
      normalized.config?.smallFastModel,
    );
    const definition = this.#registry.get(normalized.providerId);
    if (model !== undefined && !definition?.createDriver) {
      throw notApplied(
        `Workflow agent provider ${normalized.providerId} has no default driver, so the model cannot be applied`,
        normalized.providerId,
        model,
      );
    }

    const descriptor = Object.freeze({
      providerId: normalized.providerId,
      name: normalized.name,
      revision: agentRevisionFor(normalized),
      ...(model !== undefined ? { model } : {}),
    });
    const agent = this.#createAgent(normalized);
    this.#assertModelApplied(agent, normalized.providerId, model);
    this.#assertSmallFastModelApplied(
      agent,
      normalized.providerId,
      normalized.config?.smallFastModel,
    );
    const handle = Object.freeze({ descriptor, agent });
    this.#handles.set(normalized.name, handle);
    return handle;
  }

  /** Builds the agent, turning a driver's own model refusal into the factory's code. */
  #createAgent(request: WorkflowAgentFactoryRequest): ExternalAgent {
    try {
      return this.#registry.create(
        request.providerId,
        externalAgentConfig(request, this.#requireExplicitModel),
      );
    } catch (error) {
      if (
        error instanceof ExternalAgentPolicyError &&
        error.code === EXTERNAL_AGENT_MODEL_REQUIRED
      ) {
        throw new WorkflowAgentFactoryError(
          "WORKFLOW_AGENT_MODEL_REQUIRED",
          `Workflow agent provider ${request.providerId} refused the model: ${error.message}`,
          { providerId: request.providerId },
          { cause: error },
        );
      }
      throw error;
    }
  }

  /** The checks that need the created driver: it must report and keep the model. */
  #assertModelApplied(
    agent: ExternalAgent,
    providerId: string,
    model: string | undefined,
  ): void {
    const kept: unknown = agent.driver.model;
    if (
      this.#requireExplicitModel &&
      !(typeof kept === "string" && kept.length > 0)
    ) {
      throw new WorkflowAgentFactoryError(
        "WORKFLOW_AGENT_MODEL_REQUIRED",
        `Workflow agent provider ${providerId} created a driver that reports no model`,
        { providerId },
      );
    }
    if (model !== undefined && kept !== model) {
      throw notApplied(
        `Workflow agent provider ${providerId} did not keep the requested model`,
        providerId,
        model,
      );
    }
  }

  /** Under `requireExplicitModel`, the built-in `claude` id needs a `smallFastModel`. */
  private assertSmallFastModelAllowed(
    providerId: string,
    smallFastModel: string | undefined,
  ) {
    if (!this.#requireExplicitModel || providerId !== "claude") return;
    if (smallFastModel === undefined) {
      throw new WorkflowAgentFactoryError(
        "WORKFLOW_AGENT_MODEL_REQUIRED",
        "Workflow agent requires an explicit small model for the claude provider: set config.smallFastModel",
        { providerId },
      );
    }
  }

  /** Under `requireExplicitModel`, the `claude` driver must keep exactly the pin. */
  #assertSmallFastModelApplied(
    agent: ExternalAgent,
    providerId: string,
    smallFastModel: string | undefined,
  ): void {
    if (
      !this.#requireExplicitModel ||
      providerId !== "claude" ||
      smallFastModel === undefined
    ) {
      return;
    }
    if (agent.driver.smallFastModel !== smallFastModel) {
      throw notApplied(
        `Workflow agent provider ${providerId} did not keep the requested smallFastModel`,
        providerId,
        smallFastModel,
      );
    }
  }

  /** Under `requireExplicitModel`: a model must be set and not a built-in router alias. */
  private assertModelAllowed(providerId: string, model: string | undefined) {
    if (!this.#requireExplicitModel) return;
    if (model === undefined) {
      throw new WorkflowAgentFactoryError(
        "WORKFLOW_AGENT_MODEL_REQUIRED",
        "Workflow agent requires an explicit model: set config.model",
        { providerId },
      );
    }
    const denylist = Object.hasOwn(MODEL_ALIAS_DENYLIST, providerId)
      ? MODEL_ALIAS_DENYLIST[providerId as keyof typeof MODEL_ALIAS_DENYLIST]
      : undefined;
    if (denylist !== undefined && isRouterAlias(model, denylist)) {
      throw new WorkflowAgentFactoryError(
        "WORKFLOW_AGENT_MODEL_REQUIRED",
        `Workflow agent model ${JSON.stringify(model)} lets the ${providerId} runtime choose the model: set a model id or a plain alias`,
        { providerId },
      );
    }
  }

  /** {@inheritDoc WorkflowAgentFactory.get} */
  get(name: string): WorkflowAgentHandle | undefined {
    return this.#handles.get(name);
  }

  /** {@inheritDoc WorkflowAgentFactory.list} */
  list(): readonly WorkflowAgentDescriptor[] {
    return Object.freeze(
      [...this.#handles.values()].map((handle) => handle.descriptor),
    );
  }

  /**
   * Releases an active agent.
   *
   * @param handle - Handle returned by `create`.
   * @returns `false` when the handle is not the one currently active under its name.
   */
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

/**
 * Revision of a factory request: a digest of the provider id and the config
 * without its top-level `model` key.
 *
 * @remarks
 * The model is not part of the revision, so changing it is reported by the
 * replay model check (`replay.modelChange`) and does not stop completed steps
 * from replaying. Only that one key is left out: a `model` key nested anywhere
 * else in the config stays in the revision. A host that wants the model to be
 * identity sets `replay.modelChange: "mismatch"`.
 *
 * @internal
 */
export function agentRevisionFor(request: WorkflowAgentFactoryRequest): string {
  const { model: _model, ...config } = request.config ?? {};
  const fingerprint = {
    providerId: request.providerId,
    config,
  };
  const revision = canonicalDigestSync(fingerprint);
  // Steps checkpointed before 0.7.0 hold the localeCompare-ordered revision
  // (it differs when permissions set both allowNetwork and allowedPaths).
  rememberLegacyDigest(revision, legacyDigestSync(fingerprint, "locale"));
  return revision;
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
  if (config.model !== undefined && !isModelId(config.model)) {
    invalid(
      "Workflow agent model must be a model id: 1 to 256 characters, no whitespace or control characters, not starting with a dash",
    );
  }
  const model = config.model;
  if (
    config.smallFastModel !== undefined &&
    !isModelId(config.smallFastModel)
  ) {
    invalid(
      "Workflow agent smallFastModel must be a model id: 1 to 256 characters, no whitespace or control characters, not starting with a dash",
    );
  }
  const smallFastModel = config.smallFastModel;
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
    ...(model !== undefined ? { model } : {}),
    ...(smallFastModel !== undefined ? { smallFastModel } : {}),
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
  if (!isWithinRoots(normalized, policy.workingDirectoryRoots)) {
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
  if (!isWithinRoots(normalized, policy.workingDirectoryRoots)) {
    policyExceeded(
      `Workflow agent allowedPath is outside host-configured roots: ${requested}`,
    );
  }
  return normalized;
}

function externalAgentConfig(
  request: WorkflowAgentFactoryRequest,
  requireExplicitModel: boolean,
): ExternalAgentDefinitionConfig {
  const model = request.config?.model;
  const smallFastModel = request.config?.smallFastModel;
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
    ...(model !== undefined || smallFastModel !== undefined
      ? {
          driverOptions: {
            ...(model !== undefined ? { model } : {}),
            ...(smallFastModel !== undefined ? { smallFastModel } : {}),
            ...(requireExplicitModel ? { requireExplicitModel: true } : {}),
          },
        }
      : {}),
  };
}

function notApplied(
  message: string,
  providerId: string,
  model: string,
): WorkflowAgentFactoryError {
  return new WorkflowAgentFactoryError(
    "WORKFLOW_AGENT_MODEL_NOT_APPLIED",
    message,
    { providerId, model },
  );
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
  if (limits !== undefined) {
    assertOnlyKeys(limits as Record<string, unknown>, LIMIT_KEYS, "limits");
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

/**
 * Whether `path` lies within one of `roots` once symlinks are resolved on both
 * sides (the deepest existing ancestor, following dangling links), so a link
 * inside a root cannot point outside it. Resolved on every request, so a link
 * changed after the factory was built is followed to where it points now. A
 * path or root whose links loop is never within.
 */
function isWithinRoots(path: string, roots: readonly string[]): boolean {
  const real = canonicalPath(path, "/");
  if (real === undefined) return false;
  return isUnderAny(
    real,
    roots.flatMap((root) => canonicalPath(root, "/") ?? []),
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
