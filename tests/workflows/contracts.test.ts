/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WORKFLOW_EXECUTION_LIMITS,
  WorkflowError,
} from "../../src/workflows/contracts.js";
import {
  defineScriptWorkflow,
  defineWorkflow,
  isWorkflowDefinition,
} from "../../src/workflows/definition.js";

describe("workflow contracts", () => {
  test("defines immutable trusted and script workflows", () => {
    const trusted = defineWorkflow({
      id: "implementation",
      version: "1",
      handler: async () => "done",
    });
    const script = defineScriptWorkflow({
      id: "review",
      version: "2",
      source:
        'const result = yield { type: "run", step: ctx.input }; return result;',
    });

    expect(trusted.kind).toBe("trusted");
    expect(script.kind).toBe("script");
    expect(Object.isFrozen(trusted)).toBe(true);
    expect(Object.isFrozen(script)).toBe(true);
    expect(isWorkflowDefinition(trusted)).toBe(true);
    expect(isWorkflowDefinition(script)).toBe(true);
  });

  test("rejects definitions without durable identity or executable content", () => {
    expect(() =>
      defineWorkflow({ id: "", version: "1", handler: () => undefined }),
    ).toThrow("Workflow id is required");
    expect(() =>
      defineScriptWorkflow({ id: "script", version: "", source: "return;" }),
    ).toThrow("Workflow version is required");
    expect(() =>
      defineScriptWorkflow({ id: "script", version: "1", source: "  " }),
    ).toThrow("Script workflow source is required");
  });

  test("provides bounded defaults for every runtime", () => {
    expect(DEFAULT_WORKFLOW_EXECUTION_LIMITS).toEqual({
      maxSteps: 100,
      maxConcurrency: 4,
      maxAttemptsPerStep: 1,
      timeoutMs: 300_000,
      cpuTimeMs: 5_000,
      memoryBytes: 67_108_864,
      stackBytes: 524_288,
      maxSourceBytes: 262_144,
      maxMessageBytes: 1_048_576,
    });
    expect(Object.isFrozen(DEFAULT_WORKFLOW_EXECUTION_LIMITS)).toBe(true);
  });

  test("serializes stable workflow error codes", () => {
    const error = new WorkflowError(
      "WORKFLOW_LIMIT_EXCEEDED",
      "Too many steps",
      {
        limit: 100,
      },
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.toJSON()).toEqual({
      code: "WORKFLOW_LIMIT_EXCEEDED",
      message: "Too many steps",
      details: { limit: 100 },
    });
  });
});
