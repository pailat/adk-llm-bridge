/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  IntegrationGate,
  type IntegrationGateDriver,
  type IntegrationGateDriverInput,
} from "../../../src/workflows/resources/integration-gate.js";
import { InMemoryWorkflowArtifactStore } from "../../../src/workflows/resources/workflow-artifact-store.js";

describe("IntegrationGate", () => {
  test("validates an immutable ordered artifact set without mutating the store", async () => {
    const store = new InMemoryWorkflowArtifactStore();
    const first = (
      await store.put({
        artifactId: "patch",
        executionId: "execution-1",
        taskId: "task-build",
        type: "text/patch",
        content: "patch-content",
      })
    ).artifact;
    const second = (
      await store.put({
        artifactId: "tests",
        executionId: "execution-1",
        taskId: "task-test",
        type: "application/test-result",
        content: { passed: 12 },
      })
    ).artifact;
    let observed: IntegrationGateDriverInput | undefined;
    const driver: IntegrationGateDriver = {
      validate: async (input) => {
        observed = input;
        expect(Object.isFrozen(input)).toBe(true);
        expect(Object.isFrozen(input.artifacts)).toBe(true);
        return {
          verdict: "accepted",
          result: { checked: input.artifacts.length },
        };
      },
    };
    const gate = new IntegrationGate(store, driver);

    const result = await gate.validate({
      gateId: "integration-1",
      executionId: "execution-1",
      taskId: "task-integrate",
      artifacts: [
        { artifactId: second.artifactId, revision: second.revision },
        { artifactId: first.artifactId, revision: first.revision },
      ],
      context: { target: "main" },
    });

    expect(observed?.artifacts.map(({ artifactId }) => artifactId)).toEqual([
      "tests",
      "patch",
    ]);
    expect(result).toEqual({
      gateId: "integration-1",
      executionId: "execution-1",
      taskId: "task-integrate",
      artifacts: [
        { artifactId: "tests", revision: second.revision },
        { artifactId: "patch", revision: first.revision },
      ],
      verdict: "accepted",
      result: { checked: 2 },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect((await store.list()).artifacts).toHaveLength(2);
  });

  test("aborts before invoking the driver", async () => {
    const store = new InMemoryWorkflowArtifactStore();
    const stored = (
      await store.put({
        artifactId: "artifact-1",
        executionId: "execution-1",
        taskId: "task-1",
        type: "text/report",
        content: "done",
      })
    ).artifact;
    let calls = 0;
    const gate = new IntegrationGate(store, {
      validate: async () => {
        calls++;
        return { verdict: "accepted", result: null };
      },
    });

    await expect(
      gate.validate(
        {
          gateId: "gate-1",
          executionId: "execution-1",
          taskId: "task-1",
          artifacts: [
            { artifactId: stored.artifactId, revision: stored.revision },
          ],
        },
        { signal: AbortSignal.abort(new Error("cancel gate")) },
      ),
    ).rejects.toThrow("cancel gate");
    expect(calls).toBe(0);
  });

  test("cancels while an injected driver is pending even if it ignores the signal", async () => {
    const store = new InMemoryWorkflowArtifactStore();
    const stored = (
      await store.put({
        artifactId: "artifact-1",
        executionId: "execution-1",
        taskId: "task-1",
        type: "text/report",
        content: "done",
      })
    ).artifact;
    const gate = new IntegrationGate(store, {
      validate: async () => await new Promise(() => {}),
    });
    const abort = new AbortController();
    const pending = gate.validate(
      {
        gateId: "gate-1",
        executionId: "execution-1",
        taskId: "task-1",
        artifacts: [
          { artifactId: stored.artifactId, revision: stored.revision },
        ],
      },
      { signal: abort.signal },
    );
    abort.abort(new Error("driver cancelled"));

    await expect(pending).rejects.toThrow("driver cancelled");
  });

  test("rejects missing, stale, cross-execution, and duplicate references", async () => {
    const store = new InMemoryWorkflowArtifactStore();
    const stored = (
      await store.put({
        artifactId: "artifact-1",
        executionId: "execution-2",
        taskId: "task-1",
        type: "text/report",
        content: "done",
      })
    ).artifact;
    const gate = new IntegrationGate(store, {
      validate: async () => ({ verdict: "accepted", result: null }),
    });
    const base = {
      gateId: "gate-1",
      executionId: "execution-1",
      taskId: "task-1",
    };

    await expect(
      gate.validate({
        ...base,
        artifacts: [{ artifactId: "missing", revision: stored.revision }],
      }),
    ).rejects.toThrow("was not found");
    await expect(
      gate.validate({
        ...base,
        executionId: "execution-2",
        artifacts: [
          { artifactId: stored.artifactId, revision: "sha256:stale" },
        ],
      }),
    ).rejects.toThrow("revision does not match");
    await expect(
      gate.validate({
        ...base,
        artifacts: [
          { artifactId: stored.artifactId, revision: stored.revision },
        ],
      }),
    ).rejects.toThrow("another execution");
    await expect(
      gate.validate({
        ...base,
        executionId: "execution-2",
        artifacts: [
          { artifactId: stored.artifactId, revision: stored.revision },
          { artifactId: stored.artifactId, revision: stored.revision },
        ],
      }),
    ).rejects.toThrow("duplicated");
  });

  test("rejects non-JSON or malformed driver output", async () => {
    const store = new InMemoryWorkflowArtifactStore();
    const stored = (
      await store.put({
        artifactId: "artifact-1",
        executionId: "execution-1",
        taskId: "task-1",
        type: "text/report",
        content: "done",
      })
    ).artifact;
    const request = {
      gateId: "gate-1",
      executionId: "execution-1",
      taskId: "task-1",
      artifacts: [{ artifactId: stored.artifactId, revision: stored.revision }],
    };
    await expect(
      new IntegrationGate(store, {
        validate: async () => ({ verdict: "unknown", result: null }) as never,
      }).validate(request),
    ).rejects.toThrow("invalid verdict");
    await expect(
      new IntegrationGate(store, {
        validate: async () => ({
          verdict: "rejected",
          result: { invalid: Number.NaN },
        }),
      }).validate(request),
    ).rejects.toThrow("finite JSON numbers");
  });
});
