/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import { defineWorkflow } from "../../src/workflows/definition.js";
import { WorkflowDefinitionRegistry } from "../../src/workflows/registry.js";

const definition = defineWorkflow({
  id: "implementation",
  version: "1",
  handler: () => "done",
});

describe("WorkflowDefinitionRegistry", () => {
  test("is explicit, injectable, and enumerable", () => {
    const registry = new WorkflowDefinitionRegistry([definition]);

    expect(registry.has("implementation")).toBe(true);
    expect(registry.get("implementation")).toBe(definition);
    expect(registry.require("implementation")).toBe(definition);
    expect(registry.list()).toEqual([definition]);
  });

  test("rejects duplicate ids instead of silently changing versions", () => {
    const registry = new WorkflowDefinitionRegistry([definition]);
    const replacement = defineWorkflow({
      id: "implementation",
      version: "2",
      handler: () => "changed",
    });

    expect(() => registry.register(replacement)).toThrow(
      "Workflow is already registered: implementation",
    );
    expect(registry.get("implementation")?.version).toBe("1");
  });

  test("requires known workflows and supports explicit removal", () => {
    const registry = new WorkflowDefinitionRegistry([definition]);

    expect(() => registry.require("missing")).toThrow(
      "Unknown workflow: missing",
    );
    expect(registry.delete("implementation")).toBe(true);
    expect(registry.has("implementation")).toBe(false);
  });
});
