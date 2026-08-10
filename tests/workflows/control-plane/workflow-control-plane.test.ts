/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  WORKFLOW_CONTROL_PROTOCOL,
  WORKFLOW_CONTROL_PROTOCOL_VERSION,
  WorkflowControlPlane,
} from "../../../src/workflows/control-plane/workflow-control-plane.js";
import { WorkflowExecutionController } from "../../../src/workflows/execution/controller.js";
import {
  InMemoryWorkflowExecutionEventStore,
  InMemoryWorkflowExecutionStore,
} from "../../../src/workflows/execution/stores.js";
import { WorkflowActorContext } from "../../../src/workflows/orchestration/authorization.js";
import { IntegrationGate } from "../../../src/workflows/resources/integration-gate.js";
import { InMemoryWorkflowArtifactStore } from "../../../src/workflows/resources/workflow-artifact-store.js";
import type { WorkflowTaskAuthorityPort } from "../../../src/workflows/tasks/authority.js";
import type { WorkflowTaskDriverResult } from "../../../src/workflows/tasks/contracts.js";
import { WorkflowTaskController } from "../../../src/workflows/tasks/controller.js";
import {
  InMemoryWorkflowTaskCommandStore,
  InMemoryWorkflowTaskMessageStore,
  InMemoryWorkflowTaskStore,
} from "../../../src/workflows/tasks/stores.js";

describe("WorkflowControlPlane", () => {
  const envelope = {
    protocol: WORKFLOW_CONTROL_PROTOCOL,
    version: WORKFLOW_CONTROL_PROTOCOL_VERSION,
  } as const;

  test("drives executions, tasks, and live mailbox waits through JSON", async () => {
    const executions = new WorkflowExecutionController({
      store: new InMemoryWorkflowExecutionStore(),
      eventStore: new InMemoryWorkflowExecutionEventStore(),
      driver: {
        async execute(request) {
          await request.emit({
            type: "custom",
            workflowId: request.execution.workflowId,
            workflowVersion: request.execution.workflowVersion,
            executionId: request.execution.executionId,
            timestamp: 1,
            name: "accepted",
            data: { transport: "json" },
          });
          return { output: { ok: true } };
        },
      },
    });
    const taskGate = deferred<WorkflowTaskDriverResult>();
    const tasks = new WorkflowTaskController({
      store: new InMemoryWorkflowTaskStore(),
      messageStore: new InMemoryWorkflowTaskMessageStore(),
      driver: { execute: async () => await taskGate.promise },
    });
    const artifacts = new InMemoryWorkflowArtifactStore();
    const integration = new IntegrationGate(artifacts, {
      validate: async ({ artifacts: selected }) => ({
        verdict: "accepted",
        result: { revisions: selected.map(({ revision }) => revision) },
      }),
    });
    const control = new WorkflowControlPlane({
      executions,
      tasks,
      artifacts,
      integration,
      trustedHostMode: true,
    });

    const started = await control.dispatch({
      ...envelope,
      operation: "execution.start",
      payload: {
        executionId: "execution-1",
        workflowId: "implementation",
        workflowVersion: "1",
        input: { issue: 82 },
      },
    });
    expect(started).toMatchObject({ status: "queued", revision: 1 });
    await executions.wait("execution-1");
    await expect(
      control.dispatch({
        ...envelope,
        operation: "execution.status",
        payload: { executionId: "execution-1" },
      }),
    ).resolves.toMatchObject({ status: "completed", output: { ok: true } });
    await expect(
      control.dispatch({
        ...envelope,
        operation: "execution.events",
        payload: { executionId: "execution-1" },
      }),
    ).resolves.toMatchObject({
      events: [{ sequence: 1, event: { name: "accepted" } }],
    });

    const reviewActor = actor("codex", "review");
    const handle = (await control.dispatch(
      {
        ...envelope,
        operation: "task.spawn",
        payload: {
          executionId: "execution-1",
          taskId: "review",
          agentId: "codex",
          input: { patch: "artifact-1" },
          operationId: "spawn-review",
        },
      },
      { actor: reviewActor },
    )) as { executionId: string; taskId: string };
    const waiting = control.dispatch(
      { ...envelope, operation: "task.mailbox.wait", payload: handle },
      { signal: AbortSignal.timeout(1_000) },
    );
    await control.dispatch(
      {
        ...envelope,
        operation: "task.mailbox.send",
        payload: {
          ...handle,
          payload: { instruction: "review" },
          operationId: "send-review",
        },
      },
      { actor: reviewActor },
    );
    await expect(waiting).resolves.toMatchObject({
      messages: [{ sequence: 1, payload: { instruction: "review" } }],
    });
    taskGate.resolve({ output: { verdict: "accepted" } });
    await expect(
      control.dispatch({
        ...envelope,
        operation: "task.join",
        payload: handle,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      output: { verdict: "accepted" },
    });

    const stored = (await control.dispatch({
      ...envelope,
      operation: "artifact.put",
      payload: {
        artifactId: "review-1",
        executionId: "execution-1",
        taskId: "review",
        type: "review",
        content: { verdict: "accepted" },
      },
    })) as { artifact: { artifactId: string; revision: string } };
    await expect(
      control.dispatch({
        ...envelope,
        operation: "integration.validate",
        payload: {
          gateId: "merge-ready",
          executionId: "execution-1",
          taskId: "review",
          artifacts: [
            {
              artifactId: stored.artifact.artifactId,
              revision: stored.artifact.revision,
            },
          ],
        },
      }),
    ).resolves.toMatchObject({ verdict: "accepted" });

    expect(() => JSON.stringify(started)).not.toThrow();
    await expect(
      control.dispatch({
        ...envelope,
        operation: "unknown",
        payload: {},
      } as never),
    ).rejects.toMatchObject({
      code: "WORKFLOW_CONTROL_UNKNOWN_OPERATION",
    });
  });

  test("rejects malformed envelopes before reaching a controller", async () => {
    const artifacts = new InMemoryWorkflowArtifactStore();
    const control = new WorkflowControlPlane({
      executions: new WorkflowExecutionController({
        store: new InMemoryWorkflowExecutionStore(),
        eventStore: new InMemoryWorkflowExecutionEventStore(),
        driver: { execute: async () => ({}) },
      }),
      tasks: new WorkflowTaskController({
        store: new InMemoryWorkflowTaskStore(),
        messageStore: new InMemoryWorkflowTaskMessageStore(),
        driver: { execute: async () => ({}) },
      }),
      artifacts,
      integration: new IntegrationGate(artifacts, {
        validate: async () => ({ verdict: "accepted", result: null }),
      }),
    });

    await expect(
      control.dispatch({ ...envelope, operation: "execution.status" } as never),
    ).rejects.toMatchObject({ code: "WORKFLOW_CONTROL_INVALID_REQUEST" });

    const statusRequest = {
      ...envelope,
      operation: "task.status",
      payload: { executionId: "execution-1", taskId: "task-1" },
    } as const;
    await expect(control.dispatch(statusRequest)).rejects.toMatchObject({
      code: "WORKFLOW_CONTROL_INVALID_REQUEST",
    });
    await expect(
      control.dispatch(statusRequest, { actor: actor("codex", "task-1") }),
    ).rejects.toMatchObject({
      code: "WORKFLOW_CONTROL_CAPABILITY_UNAVAILABLE",
    });
    await expect(
      control.dispatch({
        ...envelope,
        version: 2,
        operation: "execution.status",
        payload: { executionId: "execution-1" },
      } as never),
    ).rejects.toMatchObject({ code: "WORKFLOW_CONTROL_INVALID_REQUEST" });
    await expect(
      control.dispatch({
        ...envelope,
        operation: "execution.status",
        payload: { executionId: "execution-1", extra: true },
      } as never),
    ).rejects.toMatchObject({ code: "WORKFLOW_CONTROL_INVALID_REQUEST" });

    await expect(
      control.dispatch({
        ...envelope,
        operation: "plan.list",
        payload: { executionId: "execution-1", actor: { actorId: "forged" } },
      } as never),
    ).rejects.toMatchObject({ code: "WORKFLOW_CONTROL_INVALID_REQUEST" });

    for (const extra of [
      { parentTaskId: "forged-parent" },
      {
        orchestration: {
          planRevision: 1,
          ownership: [{ grantId: "forged", fencingToken: 1 }],
        },
      },
    ]) {
      await expect(
        control.dispatch(
          {
            ...envelope,
            operation: "task.spawn",
            payload: {
              executionId: "execution-1",
              taskId: "task-1",
              agentId: "codex",
              operationId: "spawn-1",
              ...extra,
            },
          } as never,
          { actor: actor("codex", "task-1") },
        ),
      ).rejects.toMatchObject({ code: "WORKFLOW_CONTROL_INVALID_REQUEST" });
    }

    await expect(
      control.dispatch(
        {
          ...envelope,
          operation: "task.spawn",
          payload: {
            executionId: "execution-1",
            taskId: "task-1",
            agentId: "codex",
            operationId: "",
          },
        },
        { actor: actor("codex", "task-1") },
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_CONTROL_INVALID_REQUEST" });
  });

  test("authenticates task mutations, derives senders, and preserves idempotency", async () => {
    const taskGate = deferred<WorkflowTaskDriverResult>();
    const store = new InMemoryWorkflowTaskStore();
    const messageStore = new InMemoryWorkflowTaskMessageStore();
    const authority: WorkflowTaskAuthorityPort = {
      async resolveRoot({ capability, request }) {
        expect(capability).toBeInstanceOf(WorkflowActorContext);
        expect((capability as WorkflowActorContext).identity.taskId).toBe(
          request.taskId,
        );
        return {
          planRevision: 1,
          ownership: [{ grantId: `grant-${request.taskId}`, fencingToken: 1 }],
        };
      },
      async deriveChild() {
        throw new Error("not used");
      },
      async validateAttempt() {},
      async validateAuthenticatedSender({ actor: senderActor, sender }) {
        expect(senderActor).toBeInstanceOf(WorkflowActorContext);
        expect((senderActor as WorkflowActorContext).identity.taskId).toBe(
          sender.taskId,
        );
      },
    };
    const tasks = new WorkflowTaskController({
      store,
      messageStore,
      commandStore: new InMemoryWorkflowTaskCommandStore({
        taskStore: store,
        messageStore,
      }),
      authorityPort: authority,
      driver: { execute: async () => await taskGate.promise },
      durable: {
        workerId: "control-worker",
        leaseDurationMs: 60_000,
        heartbeatIntervalMs: 10_000,
        scheduleHeartbeat: () => ({ cancel() {} }),
      },
    });
    const artifacts = new InMemoryWorkflowArtifactStore();
    const control = new WorkflowControlPlane({
      executions: new WorkflowExecutionController({
        store: new InMemoryWorkflowExecutionStore(),
        eventStore: new InMemoryWorkflowExecutionEventStore(),
        driver: { execute: async () => ({}) },
      }),
      tasks,
      artifacts,
      integration: new IntegrationGate(artifacts, {
        validate: async () => ({ verdict: "accepted", result: null }),
      }),
      taskAccess: {
        async authorizeControl({ actor: accessActor, executionId }) {
          expect(accessActor).toBeInstanceOf(WorkflowActorContext);
          expect(accessActor.identity.executionId).toBe(executionId);
        },
      },
    });
    const senderActor = actor("sender-agent", "sender");
    const targetActor = actor("target-agent", "target");

    const spawnSender = {
      ...envelope,
      operation: "task.spawn",
      payload: {
        executionId: "execution-1",
        taskId: "sender",
        agentId: "sender-agent",
        operationId: "spawn-sender",
      },
    } as const;
    await expect(control.dispatch(spawnSender)).rejects.toMatchObject({
      code: "WORKFLOW_CONTROL_INVALID_REQUEST",
    });
    await expect(
      control.dispatch(spawnSender, {
        actor: {
          actorId: "principal-sender-agent",
          agentId: "sender-agent",
          executionId: "execution-1",
          taskId: "sender",
        } as never,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_CONTROL_INVALID_REQUEST" });
    await expect(
      control.dispatch(spawnSender, { actor: targetActor }),
    ).rejects.toMatchObject({ code: "WORKFLOW_CONTROL_INVALID_REQUEST" });
    await expect(tasks.status(spawnSender.payload)).rejects.toMatchObject({
      code: "WORKFLOW_TASK_NOT_FOUND",
    });

    const sender = await control.dispatch(spawnSender, { actor: senderActor });
    await expect(
      control.dispatch(spawnSender, { actor: senderActor }),
    ).resolves.toEqual(sender);
    await control.dispatch(
      {
        ...envelope,
        operation: "task.spawn",
        payload: {
          executionId: "execution-1",
          taskId: "target",
          agentId: "target-agent",
          operationId: "spawn-target",
        },
      },
      { actor: targetActor },
    );
    await eventually(async () => {
      expect(
        (await tasks.status({ executionId: "execution-1", taskId: "sender" }))
          .status,
      ).toBe("running");
    });

    const send = {
      ...envelope,
      operation: "task.mailbox.send",
      payload: {
        executionId: "execution-1",
        taskId: "target",
        payload: { instruction: "review" },
        operationId: "send-1",
      },
    } as const;
    await expect(control.dispatch(send)).rejects.toMatchObject({
      code: "WORKFLOW_CONTROL_INVALID_REQUEST",
    });
    await expect(
      control.dispatch(send, {
        actor: {
          actorId: "principal-sender-agent",
          agentId: "sender-agent",
          executionId: "execution-1",
          taskId: "sender",
        } as never,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_CONTROL_INVALID_REQUEST" });
    await expect(
      control.dispatch(send, {
        actor: new WorkflowActorContext({
          actorId: "principal-sender-agent",
          agentId: "sender-agent",
          executionId: "execution-other",
          taskId: "sender",
        }),
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_CONTROL_INVALID_REQUEST" });
    await expect(
      control.dispatch(
        { ...send, payload: { ...send.payload, operationId: "" } },
        { actor: senderActor },
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_CONTROL_INVALID_REQUEST" });
    await expect(
      tasks.readMailbox({ executionId: "execution-1", taskId: "target" }),
    ).resolves.toMatchObject({ messages: [] });

    const first = await control.dispatch(send, { actor: senderActor });
    await expect(
      control.dispatch(send, { actor: senderActor }),
    ).resolves.toEqual(first);
    await expect(
      control.dispatch(
        {
          ...send,
          payload: { ...send.payload, senderTaskId: "target" },
        } as never,
        { actor: senderActor },
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_CONTROL_INVALID_REQUEST" });

    taskGate.resolve({});
    await tasks.waitForIdle();
  });

  test("passes an opaque task sweep cursor through unchanged", async () => {
    const cursor = "v1:opaque/not-for-the-control-plane";
    let received: unknown;
    const artifacts = new InMemoryWorkflowArtifactStore();
    const control = new WorkflowControlPlane({
      executions: new WorkflowExecutionController({
        store: new InMemoryWorkflowExecutionStore(),
        eventStore: new InMemoryWorkflowExecutionEventStore(),
        driver: { execute: async () => ({}) },
      }),
      tasks: new WorkflowTaskController({
        store: new InMemoryWorkflowTaskStore(),
        messageStore: new InMemoryWorkflowTaskMessageStore(),
        driver: { execute: async () => ({}) },
      }),
      artifacts,
      integration: new IntegrationGate(artifacts, {
        validate: async () => ({ verdict: "accepted", result: null }),
      }),
      dispatcher: {
        async sweep(request: unknown) {
          received = request;
          return { nextCursor: cursor };
        },
      } as never,
      trustedHostMode: true,
    });

    await control.dispatch({
      ...envelope,
      operation: "task.sweep",
      payload: { executionId: "execution-1", cursor, limit: 7 },
    });
    expect(received).toEqual({ executionId: "execution-1", cursor, limit: 7 });
  });
});

function actor(agentId: string, taskId: string): WorkflowActorContext {
  return new WorkflowActorContext({
    actorId: `principal-${agentId}`,
    agentId,
    executionId: "execution-1",
    taskId,
    planRevision: 1,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function eventually(
  assertion: () => void | Promise<void>,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(1);
    }
  }
  throw lastError;
}
