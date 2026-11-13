import { describe, expect, test } from "bun:test";
import { WorkflowError } from "../../src/workflows/contracts.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
import { WorkflowDefinitionRegistry } from "../../src/workflows/registry.js";

const definition = defineWorkflow({
  id: "implementation",
  version: "1",
  handler: () => "done",
});

const nextVersion = defineWorkflow({
  id: "implementation",
  version: "2",
  handler: () => "changed",
});

function thrown(run: () => unknown): WorkflowError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowError);
    return error as WorkflowError;
  }
  throw new Error("expected a WorkflowError");
}

describe("WorkflowDefinitionRegistry", () => {
  test("is explicit, injectable, and enumerable", () => {
    const registry = new WorkflowDefinitionRegistry([definition]);

    expect(registry.has("implementation", "1")).toBe(true);
    expect(registry.get("implementation", "1")).toBe(definition);
    expect(registry.require("implementation", "1")).toBe(definition);
    expect(registry.list()).toEqual([definition]);
  });

  test("keys definitions by id and version", () => {
    const registry = new WorkflowDefinitionRegistry([definition, nextVersion]);

    expect(registry.get("implementation", "1")).toBe(definition);
    expect(registry.get("implementation", "2")).toBe(nextVersion);
    expect(registry.versions("implementation")).toEqual(["1", "2"]);
    expect(registry.versions("missing")).toEqual([]);
    expect(registry.list()).toEqual([definition, nextVersion]);
    expect(registry.has("implementation", "3")).toBe(false);
  });

  test("rejects a duplicate id and version instead of replacing it", () => {
    const registry = new WorkflowDefinitionRegistry([definition]);
    const replacement = defineWorkflow({
      id: "implementation",
      version: "1",
      handler: () => "changed",
    });

    const error = thrown(() => registry.register(replacement));
    expect(error.code).toBe("WORKFLOW_DEFINITION_INVALID");
    expect(error.message).toBe(
      "Workflow is already registered: implementation@1",
    );
    expect(error.details).toEqual({
      workflowId: "implementation",
      workflowVersion: "1",
    });
    expect(registry.get("implementation", "1")).toBe(definition);
  });

  test("require reports an unknown id or version as not found", () => {
    const registry = new WorkflowDefinitionRegistry([definition]);

    const missingId = thrown(() => registry.require("missing", "1"));
    expect(missingId.code).toBe("WORKFLOW_DEFINITION_NOT_FOUND");
    expect(missingId.message).toBe("Unknown workflow: missing@1");
    expect(missingId.details).toEqual({
      workflowId: "missing",
      workflowVersion: "1",
    });

    const missingVersion = thrown(() =>
      registry.require("implementation", "2"),
    );
    expect(missingVersion.code).toBe("WORKFLOW_DEFINITION_NOT_FOUND");
  });

  test("ids and versions that share characters do not collide", () => {
    const left = defineWorkflow({
      id: "a:b",
      version: "c",
      handler: () => "left",
    });
    const right = defineWorkflow({
      id: "a",
      version: "b:c",
      handler: () => "right",
    });
    const registry = new WorkflowDefinitionRegistry([left, right]);

    expect(registry.get("a:b", "c")).toBe(left);
    expect(registry.get("a", "b:c")).toBe(right);
  });

  test("delete removes one version only", () => {
    const registry = new WorkflowDefinitionRegistry([definition, nextVersion]);

    expect(registry.delete("implementation", "1")).toBe(true);
    expect(registry.delete("implementation", "1")).toBe(false);
    expect(registry.has("implementation", "1")).toBe(false);
    expect(registry.has("implementation", "2")).toBe(true);
  });

  test("rejects an invalid definition", () => {
    const registry = new WorkflowDefinitionRegistry();

    const error = thrown(() =>
      registry.register({ id: "x" } as unknown as typeof definition),
    );
    expect(error.code).toBe("WORKFLOW_DEFINITION_INVALID");
  });
});
