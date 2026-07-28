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
import { IntegrationGate } from "../../../src/workflows/resources/integration-gate.js";
import { InMemoryWorkflowArtifactStore } from "../../../src/workflows/resources/workflow-artifact-store.js";
import type { WorkflowTaskDriverResult } from "../../../src/workflows/tasks/contracts.js";
import { WorkflowTaskController } from "../../../src/workflows/tasks/controller.js";
import {
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

    const handle = (await control.dispatch({
      ...envelope,
      operation: "task.spawn",
      payload: {
        executionId: "execution-1",
        taskId: "review",
        agentId: "codex",
        orchestration: {
          planRevision: 1,
          ownership: [{ grantId: "grant-review", fencingToken: 1 }],
        },
        input: { patch: "artifact-1" },
      },
    })) as { executionId: string; taskId: string };
    const waiting = control.dispatch(
      { ...envelope, operation: "task.mailbox.wait", payload: handle },
      { signal: AbortSignal.timeout(1_000) },
    );
    await control.dispatch({
      ...envelope,
      operation: "task.mailbox.send",
      payload: { ...handle, payload: { instruction: "review" } },
    });
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
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
