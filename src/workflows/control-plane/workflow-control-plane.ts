import type { WorkflowExecutionController } from "../execution/controller.js";
import { WorkflowActorContext } from "../orchestration/authorization.js";
import type { WorkflowOwnershipChangeSetValidator } from "../orchestration/change-set-validator.js";
import type { WorkflowOwnershipController } from "../orchestration/ownership-controller.js";
import type { WorkflowPlanController } from "../orchestration/plan-controller.js";
import type { IntegrationGate } from "../resources/integration-gate.js";
import type { WorkflowArtifactStore } from "../resources/workflow-artifact-store.js";
import type {
  WorkflowTaskControlAccess,
  WorkflowTaskControlAccessPort,
  WorkflowTaskControlOperation,
} from "../tasks/authority.js";
import type { WorkflowTaskController } from "../tasks/controller.js";
import type { WorkflowTaskDispatcher } from "../tasks/dispatcher.js";
import { invalid, unauthorized, WorkflowControlPlaneError } from "./errors.js";
import {
  artifactKeyPayload,
  artifactListPayload,
  artifactPutPayload,
  awaitAnyPayload,
  type ControlPayload,
  controlRequest,
  controlResult,
  executionEventsPayload,
  executionIdPayload,
  executionListPayload,
  executionResumePayload,
  executionStartPayload,
  integrationPayload,
  ownershipClaimPayload,
  ownershipDecisionPayload,
  ownershipProposalPayload,
  ownershipReleasePayload,
  ownershipScopePayload,
  ownershipTransferPayload,
  ownershipValidationPayload,
  planPutPayload,
  planRevisionPayload,
  taskHandlePayload,
  taskHandleScope,
  taskListPayload,
  taskMailboxReadPayload,
  taskMailboxSendPayload,
  taskResumePayload,
  taskSpawnPayload,
  taskSweepPayload,
  type WorkflowControlOperation,
} from "./payloads.js";
import type {
  WorkflowControlPlaneRequest,
  WorkflowControlTaskSpawnPayload,
} from "./protocol.js";

export {
  WorkflowControlPlaneError,
  type WorkflowControlPlaneErrorCode,
} from "./errors.js";
export type {
  WorkflowControlPlaneEnvelope,
  WorkflowControlPlaneRequest,
  WorkflowControlTaskMailboxSendPayload,
  WorkflowControlTaskSpawnPayload,
} from "./protocol.js";
export {
  WORKFLOW_CONTROL_PROTOCOL,
  WORKFLOW_CONTROL_PROTOCOL_VERSION,
} from "./protocol.js";

/**
 * Services and options for {@link WorkflowControlPlane}.
 *
 * @remarks
 * `executions`, `tasks`, `artifacts` and `integration` are required. Each
 * optional service enables its request kinds; without it those requests are
 * rejected. Unless `trustedHostMode` is `true`, every operation needs a
 * host-authenticated actor: task operations are authorized by `taskAccess`
 * (they fail closed without it), plan and ownership operations by their
 * controller, and execution, artifact and integration operations must stay
 * inside the actor's execution (and task, when the actor is bound to one).
 * Execution operations also need an actor that is not bound to a task.
 * `trustedHostMode` does not lift the actor requirement of `plan.*` and
 * `ownership.*`.
 *
 * Artifacts are keyed by execution: every `artifact.*` request names its
 * execution, the same artifact id in another execution is a different
 * artifact, and another execution's artifact reads as absent.
 *
 * @defaultValue `trustedHostMode` is `false`.
 */
export interface WorkflowControlPlaneConfig {
  /** Serves the `execution.*` operations. Required. */
  executions: WorkflowExecutionController;
  /** Serves the `task.*` operations. Required. */
  tasks: WorkflowTaskController;
  /** Serves the `artifact.*` operations. Required. */
  artifacts: WorkflowArtifactStore;
  /** Serves `integration.validate`. Required. */
  integration: IntegrationGate;
  /** Serves the `plan.*` operations; they fail with `WORKFLOW_CONTROL_CAPABILITY_UNAVAILABLE` when absent. */
  plans?: WorkflowPlanController;
  /** Serves the `ownership.*` operations except validation; unavailable when absent. */
  ownership?: WorkflowOwnershipController;
  /** Serves `ownership.validate`; unavailable when absent. */
  changeValidation?: WorkflowOwnershipChangeSetValidator;
  /** Serves `task.sweep`; the operation fails with `WORKFLOW_CONTROL_CAPABILITY_UNAVAILABLE` when absent. */
  dispatcher?: WorkflowTaskDispatcher;
  /** Required for task operations unless trustedHostMode is explicitly enabled. */
  taskAccess?: WorkflowTaskControlAccessPort<WorkflowActorContext>;
  /**
   * Skips the actor checks of `execution.*`, `artifact.*`,
   * `integration.validate` and `task.*` (including `taskAccess`). `plan.*` and
   * `ownership.*` still need an actor, because their controllers authorize it.
   * Only for a private transport whose callers are all trusted.
   */
  trustedHostMode?: boolean;
}

/** Host-only options for one {@link WorkflowControlPlane.dispatch} call. */
export interface WorkflowControlPlaneDispatchOptions {
  /** Host-only cancellation for long-poll operations. Never serialized. */
  signal?: AbortSignal;
  /** Host-authenticated orchestration identity. Never accepted from JSON. */
  actor?: WorkflowActorContext;
}

/**
 * JSON-only facade for HTTP, RPC, or MCP transports.
 *
 * It intentionally owns no socket, process, credential, or provider handle;
 * transport adapters only need to forward one request object to `dispatch`.
 */
export class WorkflowControlPlane {
  readonly #executions: WorkflowExecutionController;
  readonly #tasks: WorkflowTaskController;
  readonly #artifacts: WorkflowArtifactStore;
  readonly #integration: IntegrationGate;
  readonly #plans: WorkflowPlanController | undefined;
  readonly #ownership: WorkflowOwnershipController | undefined;
  readonly #changeValidation: WorkflowOwnershipChangeSetValidator | undefined;
  readonly #dispatcher: WorkflowTaskDispatcher | undefined;
  readonly #taskAccess:
    | WorkflowTaskControlAccessPort<WorkflowActorContext>
    | undefined;
  readonly #trustedHostMode: boolean;

  /**
   * Creates a control plane over the given services.
   *
   * @param config - The services the control plane forwards operations to.
   * @throws {@link WorkflowControlPlaneError} with code
   * `WORKFLOW_CONTROL_INVALID_REQUEST` when `executions`, `tasks`,
   * `artifacts` or `integration` is missing.
   */
  constructor(config: WorkflowControlPlaneConfig) {
    if (
      !config?.executions ||
      !config.tasks ||
      !config.artifacts ||
      !config.integration
    ) {
      throw new WorkflowControlPlaneError(
        "WORKFLOW_CONTROL_INVALID_REQUEST",
        "Workflow control plane requires execution, task, artifact, and integration services",
      );
    }
    this.#executions = config.executions;
    this.#tasks = config.tasks;
    this.#artifacts = config.artifacts;
    this.#integration = config.integration;
    this.#plans = config.plans;
    this.#ownership = config.ownership;
    this.#changeValidation = config.changeValidation;
    this.#dispatcher = config.dispatcher;
    if (
      config.trustedHostMode !== undefined &&
      typeof config.trustedHostMode !== "boolean"
    ) {
      invalid("Workflow control trustedHostMode must be boolean");
    }
    this.#taskAccess = config.taskAccess;
    this.#trustedHostMode = config.trustedHostMode ?? false;
  }

  /**
   * Validates a control request, routes it to its service, and revalidates
   * the result.
   *
   * @remarks
   * JSON fields of the payload reach the service as validated, frozen copies,
   * never as the caller's objects. The result is a frozen JSON copy of what
   * the service returned.
   *
   * @param request - The request, usually parsed from a transport.
   * @param options - Host-only options: abort signal and authenticated actor.
   * @returns The operation's result as a frozen JSON value (`undefined` for an
   * `artifact.get` that finds nothing, or that names another execution than
   * the actor's). `artifact.get` and `artifact.list` drop any artifact of
   * another execution than the request's, even when the store returns one.
   * @throws {@link WorkflowControlPlaneError} with code
   * `WORKFLOW_CONTROL_INVALID_REQUEST` (bad envelope or payload),
   * `WORKFLOW_CONTROL_UNAUTHORIZED` (no host-authenticated actor, or one bound
   * to another execution or task),
   * `WORKFLOW_CONTROL_UNKNOWN_OPERATION`,
   * `WORKFLOW_CONTROL_CAPABILITY_UNAVAILABLE`, or
   * `WORKFLOW_CONTROL_INVALID_RESULT` (a service returned a non-JSON value or
   * the wrong shape). Errors of the services themselves propagate unchanged.
   */
  async dispatch(
    request: WorkflowControlPlaneRequest,
    options: WorkflowControlPlaneDispatchOptions = {},
  ): Promise<unknown> {
    const { operation, payload } = controlRequest(request);
    return controlResult(
      operation,
      await this.#route(operation, payload, options),
    );
  }

  async #route(
    operation: WorkflowControlOperation,
    raw: ControlPayload,
    options: WorkflowControlPlaneDispatchOptions,
  ): Promise<unknown> {
    switch (operation) {
      case "execution.start": {
        const payload = executionStartPayload(raw);
        this.#authorizeExecution(options, payload.executionId);
        return await this.#executions.start(payload);
      }
      case "execution.resume": {
        const payload = executionResumePayload(raw);
        this.#authorizeExecution(options, payload.executionId);
        return await this.#executions.resume(payload);
      }
      case "execution.status": {
        const executionId = executionIdPayload(raw);
        this.#authorizeExecution(options, executionId);
        return await this.#executions.status(executionId);
      }
      case "execution.cancel": {
        const executionId = executionIdPayload(raw);
        this.#authorizeExecution(options, executionId);
        return await this.#executions.cancel(executionId);
      }
      case "execution.list": {
        const payload = executionListPayload(raw);
        this.#authorizeScope(options, undefined);
        return await this.#executions.list(payload);
      }
      case "execution.events": {
        const payload = executionEventsPayload(raw);
        this.#authorizeExecution(options, payload.executionId);
        return await this.#executions.events(payload);
      }
      case "task.spawn": {
        const payload = taskSpawnPayload(raw);
        if (this.#trustedHostMode && options.actor === undefined) {
          return await this.#tasks.spawn({
            executionId: payload.executionId,
            taskId: payload.taskId,
            agentId: payload.agentId,
            ...(payload.input === undefined ? {} : { input: payload.input }),
          });
        }
        const actor = requiredTaskSpawnActor(options.actor, payload);
        await this.#authorizeTask(
          actor,
          "task.spawn",
          "self-spawn",
          payload.executionId,
          [payload.taskId],
        );
        return await this.#tasks.spawn(
          {
            executionId: payload.executionId,
            taskId: payload.taskId,
            agentId: payload.agentId,
            ...(payload.input === undefined ? {} : { input: payload.input }),
          },
          { capability: actor, operationId: payload.operationId },
        );
      }
      case "task.resume": {
        const payload = taskResumePayload(raw);
        await this.#authorizeTaskFromOptions(
          options,
          "task.resume",
          "self-or-manager",
          payload.executionId,
          [payload.taskId],
        );
        return await this.#tasks.resume(payload);
      }
      case "task.dispatch": {
        const payload = taskHandlePayload(raw);
        await this.#authorizeTaskFromOptions(
          options,
          "task.dispatch",
          "manager",
          payload.executionId,
          [payload.taskId],
        );
        return await this.#tasks.dispatch(payload);
      }
      case "task.recover": {
        const payload = taskHandlePayload(raw);
        await this.#authorizeTaskFromOptions(
          options,
          "task.recover",
          "manager",
          payload.executionId,
          [payload.taskId],
        );
        return await this.#tasks.recoverExpired(payload);
      }
      case "task.sweep": {
        const payload = taskSweepPayload(raw);
        await this.#authorizeTaskFromOptions(
          options,
          "task.sweep",
          "manager",
          payload.executionId,
          [],
        );
        return await requiredCapability(this.#dispatcher, "task.sweep").sweep(
          payload,
        );
      }
      case "task.status": {
        const payload = taskHandlePayload(raw);
        await this.#authorizeTaskFromOptions(
          options,
          "task.status",
          "self-read",
          payload.executionId,
          [payload.taskId],
        );
        return await this.#tasks.status(payload);
      }
      case "task.cancel": {
        const payload = taskHandlePayload(raw);
        await this.#authorizeTaskFromOptions(
          options,
          "task.cancel",
          "self-or-manager",
          payload.executionId,
          [payload.taskId],
        );
        return await this.#tasks.cancel(payload);
      }
      case "task.list": {
        const payload = taskListPayload(raw);
        await this.#authorizeTaskFromOptions(
          options,
          "task.list",
          "manager",
          payload.executionId,
          [],
        );
        return await this.#tasks.list(payload);
      }
      case "task.join": {
        const payload = taskHandlePayload(raw);
        await this.#authorizeTaskFromOptions(
          options,
          "task.join",
          "self-read",
          payload.executionId,
          [payload.taskId],
        );
        return await this.#tasks.join(payload, options.signal);
      }
      case "task.awaitAny": {
        const handles = awaitAnyPayload(raw);
        const scope = taskHandleScope(handles, "task awaitAny");
        await this.#authorizeTaskFromOptions(
          options,
          "task.awaitAny",
          "self-read",
          scope.executionId,
          scope.taskIds,
        );
        return await this.#tasks.awaitAny(handles, options.signal);
      }
      case "task.mailbox.send": {
        const payload = taskMailboxSendPayload(raw);
        if (this.#trustedHostMode && options.actor === undefined) {
          return await this.#tasks.send({
            executionId: payload.executionId,
            taskId: payload.taskId,
            payload: payload.payload,
          });
        }
        const { actor, senderTaskId } = requiredMailboxSender(
          options.actor,
          payload.executionId,
        );
        await this.#authorizeTask(
          actor,
          "task.mailbox.send",
          "self-send",
          payload.executionId,
          [senderTaskId],
        );
        return await this.#tasks.send(
          {
            executionId: payload.executionId,
            taskId: payload.taskId,
            senderTaskId,
            payload: payload.payload,
          },
          { actor, operationId: payload.operationId },
        );
      }
      case "task.mailbox.read": {
        const payload = taskMailboxReadPayload(raw);
        await this.#authorizeTaskFromOptions(
          options,
          "task.mailbox.read",
          "self-read",
          payload.executionId,
          [payload.taskId],
        );
        return await this.#tasks.readMailbox(payload);
      }
      case "task.mailbox.wait": {
        const payload = taskMailboxReadPayload(raw);
        await this.#authorizeTaskFromOptions(
          options,
          "task.mailbox.wait",
          "self-read",
          payload.executionId,
          [payload.taskId],
        );
        return await this.#tasks.waitForMessages(payload, options.signal);
      }
      case "artifact.put": {
        const payload = artifactPutPayload(raw);
        this.#authorizeScope(options, payload.executionId, payload.taskId);
        // The store keys artifacts by execution, so a conflict it reports is
        // always inside the actor's own execution.
        return await this.#artifacts.put(payload, { signal: options.signal });
      }
      case "artifact.get": {
        const key = artifactKeyPayload(raw);
        const actor = this.#trustedHostMode
          ? undefined
          : requiredActor(options.actor);
        // Another execution's artifact reads as absent, without asking the
        // store, so a get cannot tell it apart from a missing id.
        if (
          actor !== undefined &&
          actor.identity.executionId !== key.executionId
        ) {
          return undefined;
        }
        const artifact = await this.#artifacts.get({
          ...key,
          signal: options.signal,
        });
        // Fail closed on a store that ignores the execution id.
        return artifact?.executionId === key.executionId ? artifact : undefined;
      }
      case "artifact.list": {
        const payload = artifactListPayload(raw);
        this.#authorizeScope(options, payload.executionId);
        const page = await this.#artifacts.list({
          ...payload,
          signal: options.signal,
        });
        // Fail closed on a store that ignores the execution id: drop other
        // executions' artifacts and keep the store's cursor.
        if (!Array.isArray(page?.artifacts)) {
          throw new WorkflowControlPlaneError(
            "WORKFLOW_CONTROL_INVALID_RESULT",
            "Workflow artifact list result has no artifacts array",
          );
        }
        return {
          ...page,
          artifacts: page.artifacts.filter(
            (artifact) => artifact?.executionId === payload.executionId,
          ),
        };
      }
      case "integration.validate": {
        const payload = integrationPayload(raw);
        this.#authorizeScope(options, payload.executionId, payload.taskId);
        return await this.#integration.validate(payload, {
          signal: options.signal,
        });
      }
      case "plan.put": {
        const payload = planPutPayload(raw);
        return await requiredCapability(this.#plans, "plan.put").put(
          payload,
          requiredActor(options.actor),
        );
      }
      case "plan.get": {
        const payload = planRevisionPayload(raw, "plan get");
        return await requiredCapability(this.#plans, "plan.get").get(
          payload.executionId,
          payload.planRevision,
          requiredActor(options.actor),
        );
      }
      case "plan.list": {
        const executionId = executionIdPayload(raw);
        return await requiredCapability(this.#plans, "plan.list").list(
          executionId,
          requiredActor(options.actor),
        );
      }
      case "plan.activate": {
        const payload = planRevisionPayload(raw, "plan activate");
        return await requiredCapability(this.#plans, "plan.activate").activate(
          payload.executionId,
          payload.planRevision,
          requiredActor(options.actor),
        );
      }
      case "ownership.claim": {
        const payload = ownershipClaimPayload(raw);
        return await requiredCapability(
          this.#ownership,
          "ownership.claim",
        ).claim(payload, requiredActor(options.actor));
      }
      case "ownership.propose": {
        const payload = ownershipProposalPayload(raw);
        return await requiredCapability(
          this.#ownership,
          "ownership.propose",
        ).propose(payload, requiredActor(options.actor));
      }
      case "ownership.approve":
      case "ownership.reject": {
        const payload = ownershipDecisionPayload(raw);
        const controller = requiredCapability(this.#ownership, operation);
        const actor = requiredActor(options.actor);
        return operation === "ownership.approve"
          ? await controller.approve(payload, actor)
          : await controller.reject(payload, actor);
      }
      case "ownership.transfer": {
        const payload = ownershipTransferPayload(raw);
        return await requiredCapability(
          this.#ownership,
          "ownership.transfer",
        ).transfer(payload, requiredActor(options.actor));
      }
      case "ownership.release": {
        const payload = ownershipReleasePayload(raw);
        return await requiredCapability(
          this.#ownership,
          "ownership.release",
        ).release(payload, requiredActor(options.actor));
      }
      case "ownership.list": {
        const payload = ownershipScopePayload(raw);
        return await requiredCapability(this.#ownership, "ownership.list").list(
          payload,
          requiredActor(options.actor),
        );
      }
      case "ownership.validate": {
        const payload = ownershipValidationPayload(raw);
        return await requiredCapability(
          this.#changeValidation,
          "ownership.validate",
        ).validate(payload, requiredActor(options.actor));
      }
      default:
        return unknownOperation(operation);
    }
  }

  /**
   * Checks an execution operation: the actor must be bound to the execution
   * and not to one of its tasks.
   *
   * @remarks
   * Starting, resuming, cancelling and reading an execution act on the whole
   * execution, so a task-bound actor reads its own state through the task
   * operations instead.
   */
  #authorizeExecution(
    options: WorkflowControlPlaneDispatchOptions,
    executionId: string,
  ): void {
    if (this.#trustedHostMode) return;
    this.#authorizeScope(options, executionId);
    if (requiredActor(options.actor).identity.taskId !== undefined) {
      unauthorized(
        "Workflow execution operations require an actor that is not bound to a task",
      );
    }
  }

  /**
   * Checks that the request stays inside the actor's execution and, when the
   * actor is bound to a task, inside that task.
   *
   * @remarks
   * Trusted host mode skips the check. Otherwise a request that names no
   * execution (`execution.list`) cannot be
   * scoped to an actor and is rejected.
   */
  #authorizeScope(
    options: WorkflowControlPlaneDispatchOptions,
    executionId: string | undefined,
    taskId?: string,
  ): void {
    if (this.#trustedHostMode) return;
    const identity = requiredActor(options.actor).identity;
    if (executionId === undefined) {
      unauthorized(
        "Workflow control operation without an execution scope requires trusted host mode",
      );
    }
    if (identity.executionId !== executionId) {
      unauthorized("Workflow actor is bound to a different execution");
    }
    if (
      taskId !== undefined &&
      identity.taskId !== undefined &&
      identity.taskId !== taskId
    ) {
      unauthorized("Workflow actor is bound to a different task");
    }
  }

  async #authorizeTaskFromOptions(
    options: WorkflowControlPlaneDispatchOptions,
    operation: WorkflowTaskControlOperation,
    access: WorkflowTaskControlAccess,
    executionId: string,
    taskIds: readonly string[],
  ): Promise<void> {
    if (this.#trustedHostMode) return;
    await this.#authorizeTask(
      requiredActor(options.actor),
      operation,
      access,
      executionId,
      taskIds,
    );
  }

  async #authorizeTask(
    actor: WorkflowActorContext,
    operation: WorkflowTaskControlOperation,
    access: WorkflowTaskControlAccess,
    executionId: string,
    taskIds: readonly string[],
  ): Promise<void> {
    if (this.#trustedHostMode) return;
    await requiredCapability(this.#taskAccess, operation).authorizeControl({
      actor,
      operation,
      access,
      executionId,
      taskIds,
    });
  }
}

// --- actors and capabilities ----------------------------------------------

function requiredActor(actor: unknown): WorkflowActorContext {
  if (!(actor instanceof WorkflowActorContext))
    unauthorized(
      "Workflow control operation requires a host-authenticated actor",
    );
  return actor;
}

function requiredTaskSpawnActor(
  actorValue: unknown,
  payload: WorkflowControlTaskSpawnPayload,
): WorkflowActorContext {
  const actor = requiredActor(actorValue);
  const identity = actor.identity;
  if (
    identity.executionId !== payload.executionId ||
    identity.taskId !== payload.taskId ||
    identity.agentId !== payload.agentId
  ) {
    unauthorized("Workflow control task spawn actor does not match the target");
  }
  return actor;
}

function requiredMailboxSender(
  actorValue: unknown,
  executionId: string,
): { actor: WorkflowActorContext; senderTaskId: string } {
  const actor = requiredActor(actorValue);
  const { executionId: actorExecutionId, taskId } = actor.identity;
  if (actorExecutionId !== executionId || taskId === undefined) {
    unauthorized("Workflow control mailbox actor does not match the execution");
  }
  return { actor, senderTaskId: taskId };
}

function requiredCapability<T>(
  capability: T | undefined,
  operation: string,
): T {
  if (capability === undefined) {
    throw new WorkflowControlPlaneError(
      "WORKFLOW_CONTROL_CAPABILITY_UNAVAILABLE",
      `Workflow control capability is unavailable: ${operation}`,
    );
  }
  return capability;
}

function unknownOperation(value: never): never {
  throw new WorkflowControlPlaneError(
    "WORKFLOW_CONTROL_UNKNOWN_OPERATION",
    `Unknown workflow control operation: ${String(value)}`,
  );
}
