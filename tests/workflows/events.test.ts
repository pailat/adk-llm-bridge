/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import { isWorkflowEvent } from "../../src/workflows/events.js";

describe("workflow events", () => {
  test("recognizes a workflow event envelope", () => {
    expect(
      isWorkflowEvent({
        type: "workflow_started",
        workflowId: "implementation",
        workflowVersion: "1",
        executionId: "inv-1",
        timestamp: 1,
      }),
    ).toBe(true);
  });

  test("rejects incomplete or unknown event envelopes", () => {
    expect(isWorkflowEvent({ type: "workflow_started" })).toBe(false);
    expect(
      isWorkflowEvent({
        type: "invented",
        workflowId: "implementation",
        workflowVersion: "1",
        executionId: "inv-1",
        timestamp: 1,
      }),
    ).toBe(false);
  });
});
