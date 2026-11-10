import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WORKFLOW_EXECUTION_LIMITS,
  WorkflowError,
  type WorkflowStep,
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
    // Ids and versions use the opaque id grammar: no surrounding spaces.
    expect(() =>
      defineWorkflow({ id: " a ", version: "1", handler: () => undefined }),
    ).toThrow('Workflow id is invalid: " a "');
    expect(() =>
      defineWorkflow({ id: "a", version: "1 0", handler: () => undefined }),
    ).toThrow('Workflow version is invalid: "1 0"');
    expect(
      defineWorkflow({
        id: "team/implementation",
        version: "1.0.0+build.2",
        handler: () => undefined,
      }).version,
    ).toBe("1.0.0+build.2");
    expect(
      isWorkflowDefinition({
        id: " a ",
        version: "1",
        kind: "script",
        source: "return;",
      }),
    ).toBe(false);
  });

  test("returns false for a definition whose fields cannot be read", () => {
    const trap = () => {
      throw new Error("trap");
    };
    const throwingId = {
      get id(): string {
        throw new Error("trap");
      },
      version: "1",
      kind: "script",
      source: "return;",
    };
    const throwingSource = {
      id: "script",
      version: "1",
      kind: "script",
      get source(): string {
        throw new Error("trap");
      },
    };
    const proxy = new Proxy({}, { get: trap, has: trap, ownKeys: trap });
    for (const value of [throwingId, throwingSource, proxy]) {
      expect(isWorkflowDefinition(value)).toBe(false);
    }
  });

  test("returns false or a definition error for fields of the wrong type", () => {
    const wrongTypes: unknown[] = [
      { id: 1, version: "1", kind: "script", source: "return;" },
      { id: "script", version: 2, kind: "script", source: "return;" },
      { id: "script", version: "1", kind: "script", source: 42 },
      { id: { trim: () => "x" }, version: "1", kind: "script", source: "x" },
    ];
    for (const value of wrongTypes) {
      expect(isWorkflowDefinition(value)).toBe(false);
    }

    const invalidInputs: unknown[] = [
      undefined,
      null,
      { id: 1, version: "1", source: "return;" },
      { id: "script", version: ["1"], source: "return;" },
      { id: "script", version: "1", source: 42 },
    ];
    for (const value of invalidInputs) {
      expectDefinitionInvalid(() => defineScriptWorkflow(value as never));
    }
    expectDefinitionInvalid(() =>
      defineWorkflow({ id: 7, version: "1", handler: () => "" } as never),
    );
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

  test("allows steps to opt into workspace write ownership", () => {
    const legacyStep: WorkflowStep = {
      id: "read-only",
      agentName: "reader",
      input: "inspect",
    };
    const writingStep: WorkflowStep = {
      id: "implementation",
      agentName: "implementer",
      input: "edit",
      writePaths: ["src/workflows", "tests/workflows"],
    };

    expect(legacyStep.writePaths).toBeUndefined();
    expect(writingStep.writePaths).toEqual([
      "src/workflows",
      "tests/workflows",
    ]);
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

function expectDefinitionInvalid(action: () => unknown): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WorkflowError);
  expect((caught as WorkflowError).code).toBe("WORKFLOW_DEFINITION_INVALID");
}
