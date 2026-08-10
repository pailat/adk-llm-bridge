/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  isWorkflowOrchestrationMessage,
  parseWorkflowOrchestrationMessage,
} from "../../../src/workflows/orchestration/messages.js";

describe("workflow orchestration messages", () => {
  test("parses a versioned typed envelope into an immutable snapshot", () => {
    const input = message({
      kind: "DependencyRequest",
      payload: {
        dependencyTaskId: "contracts",
        request: "Publish the ownership contract",
      },
    });
    const parsed = parseWorkflowOrchestrationMessage(input);

    expect(parsed).toMatchObject({
      protocol: "adk-llm-bridge/orchestration-message",
      version: 1,
      planRevision: 1,
      kind: "DependencyRequest",
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.payload)).toBe(true);
    expect(isWorkflowOrchestrationMessage(input)).toBe(true);
  });

  test("rejects unknown fields, unknown kinds, and unsafe paths", () => {
    expect(() =>
      parseWorkflowOrchestrationMessage({ ...message(), authenticated: true }),
    ).toThrow("unknown field");
    expect(() =>
      parseWorkflowOrchestrationMessage(message({ kind: "ShellCommand" })),
    ).toThrow("kind is invalid");
    expect(() =>
      parseWorkflowOrchestrationMessage(
        message({ kind: "PathCreated", payload: { path: "../escape" } }),
      ),
    ).toThrow("normalized repository-relative path");
  });

  test("validates decision correlations and integration change paths", () => {
    expect(
      parseWorkflowOrchestrationMessage(
        message({
          kind: "OwnershipDecision",
          correlationId: "message-1",
          payload: {
            proposalId: "proposal-1",
            status: "approved",
            reason: "No overlap",
          },
        }),
      ),
    ).toMatchObject({ correlationId: "message-1" });
    expect(() =>
      parseWorkflowOrchestrationMessage(
        message({
          kind: "IntegrationRequest",
          payload: { commit: "abc123", changedPaths: ["src/a", "src/a"] },
        }),
      ),
    ).toThrow("must be unique");
  });
});

function message(overrides: Record<string, unknown> = {}) {
  return {
    protocol: "adk-llm-bridge/orchestration-message",
    version: 1,
    messageId: "message-1",
    executionId: "execution-1",
    planRevision: 1,
    senderTaskId: "task-a",
    recipientTaskId: "integration",
    createdAt: 1,
    kind: "Blocker",
    payload: { summary: "Waiting for a contract", blockedTaskIds: [] },
    ...overrides,
  };
}
