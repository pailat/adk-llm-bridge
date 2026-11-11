import { describe, expect, test } from "bun:test";
import { ExternalAgentDefinitionRegistry } from "../../../src/agents/agent-registry.js";
import { PlaceholderExternalAgentDriver } from "../../../src/agents/external-agent-driver.js";
import { ExternalAgentWorkflowFactory } from "../../../src/workflows/agents/external-agent-workflow-factory.js";
import { WorkflowAgentFactoryError } from "../../../src/workflows/agents/workflow-agent-factory.js";

function registry() {
  return new ExternalAgentDefinitionRegistry([
    {
      provider: { id: "codex", name: "Codex" },
      createDriver: () => new PlaceholderExternalAgentDriver("codex"),
    },
  ]);
}

function build(options: Record<string, unknown>): ExternalAgentWorkflowFactory {
  return new ExternalAgentWorkflowFactory({
    registry: registry(),
    ...options,
  } as ConstructorParameters<typeof ExternalAgentWorkflowFactory>[0]);
}

function invalidMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowAgentFactoryError);
    expect((error as WorkflowAgentFactoryError).code).toBe(
      "WORKFLOW_AGENT_INVALID_REQUEST",
    );
    return (error as Error).message;
  }
  throw new Error("expected the factory constructor to throw");
}

describe("ExternalAgentWorkflowFactory unknown options", () => {
  test("a top-level allowFullAccess (it belongs in policy) is refused and named", () => {
    const message = invalidMessage(() => build({ allowFullAccess: true }));
    expect(message).toContain("allowFullAccess");
    expect(message).toContain("unknown fields");
  });

  test("several unknown top-level keys are listed sorted", () => {
    const message = invalidMessage(() => build({ zeta: 1, alpha: 2 }));
    expect(message).toContain("alpha, zeta");
  });

  test("a misspelled limit is refused and named", () => {
    const message = invalidMessage(() => build({ limits: { maxTurnz: 2 } }));
    expect(message).toContain("maxTurnz");
    expect(message).toContain("limits");
  });

  test("a known limit mixed with an unknown one is still refused", () => {
    const message = invalidMessage(() =>
      build({ limits: { maxAgents: 4, maxAgentz: 4 } }),
    );
    expect(message).toContain("maxAgentz");
    expect(message).not.toContain("maxAgents,");
  });

  test("every documented top-level key is still accepted", () => {
    expect(() =>
      build({
        allowedProviderIds: ["codex"],
        limits: { maxAgents: 2 },
        policy: { allowFullAccess: false },
        requireExplicitModel: false,
      }),
    ).not.toThrow();
  });

  test("every documented limit key is still accepted", () => {
    expect(() =>
      build({
        limits: {
          maxAgents: 1,
          maxNameLength: 10,
          maxProviderIdLength: 10,
          maxDescriptionLength: 10,
          maxInstructionLength: 10,
          maxWorkingDirectoryLength: 10,
          maxAllowedPaths: 10,
          maxAllowedPathLength: 10,
        },
      }),
    ).not.toThrow();
  });

  test("registry-only options and undefined optional keys are accepted", () => {
    expect(() => build({})).not.toThrow();
    expect(() =>
      build({
        limits: undefined,
        policy: undefined,
        allowedProviderIds: undefined,
      }),
    ).not.toThrow();
  });
});
