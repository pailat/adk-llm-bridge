/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import { BaseAgent } from "@google/adk";
import { ExternalAgentDefinitionRegistry } from "../../../src/agents/agent-registry.js";
import { ExternalAgent } from "../../../src/agents/external-agent.js";
import { PlaceholderExternalAgentDriver } from "../../../src/agents/external-agent-driver.js";
import { ExternalAgentWorkflowFactory } from "../../../src/workflows/agents/external-agent-workflow-factory.js";
import { WorkflowAgentFactoryError } from "../../../src/workflows/agents/workflow-agent-factory.js";

function registry() {
  return new ExternalAgentDefinitionRegistry([
    {
      provider: { id: "codex", name: "Codex" },
      createDriver: () => new PlaceholderExternalAgentDriver("codex"),
    },
    {
      provider: { id: "claude", name: "Claude" },
      createDriver: () => new PlaceholderExternalAgentDriver("claude"),
    },
  ]);
}

describe("ExternalAgentWorkflowFactory", () => {
  test("creates a host-only BaseAgent handle from provider id and safe config", () => {
    const factory = new ExternalAgentWorkflowFactory({
      registry: registry(),
      policy: { workingDirectoryRoots: ["/workspace"] },
    });
    const handle = factory.create({
      providerId: "codex",
      name: "reviewer_1",
      config: {
        description: "Reviews a bounded change",
        instruction: "Inspect the assigned files.",
        workingDirectory: "/workspace/reviewer",
        permissions: {
          mode: "workspace-write",
          allowNetwork: false,
          allowedPaths: ["src/reviewer"],
        },
      },
    });

    expect(handle.agent).toBeInstanceOf(BaseAgent);
    expect(handle.agent).toBeInstanceOf(ExternalAgent);
    expect(handle.descriptor).toEqual({
      providerId: "codex",
      name: "reviewer_1",
    });
    expect(handle.agent.name).toBe("reviewer_1");
    expect((handle.agent as ExternalAgent).provider.id).toBe("codex");
    expect((handle.agent as ExternalAgent).workingDirectory).toBe(
      "/workspace/reviewer",
    );
    expect(factory.get("reviewer_1")).toBe(handle);
    expect(factory.list()).toEqual([handle.descriptor]);
  });

  test("enforces provider allowlists before registry lookup", () => {
    const factory = new ExternalAgentWorkflowFactory({
      registry: registry(),
      allowedProviderIds: ["codex"],
    });

    expectFactoryError(
      () => factory.create({ providerId: "claude", name: "worker" }),
      "WORKFLOW_AGENT_PROVIDER_NOT_ALLOWED",
    );
    expectFactoryError(
      () => factory.create({ providerId: "unknown", name: "worker" }),
      "WORKFLOW_AGENT_PROVIDER_NOT_ALLOWED",
    );

    const unrestricted = new ExternalAgentWorkflowFactory({
      registry: registry(),
    });
    expectFactoryError(
      () => unrestricted.create({ providerId: "unknown", name: "worker" }),
      "WORKFLOW_AGENT_UNKNOWN_PROVIDER",
    );
  });

  test("rejects unsafe, duplicate, and overlong names deterministically", () => {
    const factory = new ExternalAgentWorkflowFactory({ registry: registry() });

    expectFactoryError(
      () => factory.create({ providerId: "codex", name: "../worker" }),
      "WORKFLOW_AGENT_INVALID_REQUEST",
    );
    expectFactoryError(
      () => factory.create({ providerId: "codex", name: "a".repeat(65) }),
      "WORKFLOW_AGENT_INVALID_REQUEST",
    );

    factory.create({ providerId: "codex", name: "worker" });
    expectFactoryError(
      () => factory.create({ providerId: "claude", name: "worker" }),
      "WORKFLOW_AGENT_DUPLICATE_NAME",
    );
  });

  test("limits active agents and protects reacquisition from stale handles", () => {
    const factory = new ExternalAgentWorkflowFactory({
      registry: registry(),
      limits: { maxAgents: 1 },
    });
    const first = factory.create({ providerId: "codex", name: "worker" });

    expectFactoryError(
      () => factory.create({ providerId: "claude", name: "other" }),
      "WORKFLOW_AGENT_LIMIT_EXCEEDED",
    );
    expect(factory.release(first)).toBe(true);
    expect(factory.release(first)).toBe(false);

    const reacquired = factory.create({
      providerId: "claude",
      name: "worker",
    });
    expect(factory.release(first)).toBe(false);
    expect(factory.get("worker")).toBe(reacquired);
  });

  test("rejects non-JSON host capabilities instead of forwarding secrets", () => {
    const factory = new ExternalAgentWorkflowFactory({ registry: registry() });
    const credentialProvider = {
      secret: "must-not-cross-boundary",
      async getCredential() {
        return { kind: "api-key" as const, value: this.secret };
      },
    };

    expectFactoryError(
      () =>
        factory.create({
          providerId: "codex",
          name: "worker",
          config: { credentialProvider } as never,
        }),
      "WORKFLOW_AGENT_INVALID_REQUEST",
    );
    expect(JSON.stringify(factory.list())).not.toContain(
      credentialProvider.secret,
    );
  });

  test("denies elevated permissions and working directories by default", () => {
    const factory = new ExternalAgentWorkflowFactory({ registry: registry() });

    expectFactoryError(
      () =>
        factory.create({
          providerId: "codex",
          name: "admin",
          config: { permissions: { mode: "full-access" } },
        }),
      "WORKFLOW_AGENT_POLICY_EXCEEDED",
    );
    expectFactoryError(
      () =>
        factory.create({
          providerId: "codex",
          name: "networked",
          config: {
            permissions: { mode: "workspace-write", allowNetwork: true },
          },
        }),
      "WORKFLOW_AGENT_POLICY_EXCEEDED",
    );
    expectFactoryError(
      () =>
        factory.create({
          providerId: "codex",
          name: "worker",
          config: { workingDirectory: "/workspace/worker" },
        }),
      "WORKFLOW_AGENT_POLICY_EXCEEDED",
    );
    expectFactoryError(
      () =>
        factory.create({
          providerId: "codex",
          name: "path_owner",
          config: {
            permissions: {
              mode: "workspace-write",
              allowedPaths: ["/workspace"],
            },
          },
        }),
      "WORKFLOW_AGENT_POLICY_EXCEEDED",
    );
  });

  test("accepts explicit host opt-ins and normalizes configured roots", () => {
    const factory = new ExternalAgentWorkflowFactory({
      registry: registry(),
      policy: {
        allowFullAccess: true,
        allowNetwork: true,
        workingDirectoryRoots: ["/workspace/allowed/", "/workspace/other"],
      },
    });
    const handle = factory.create({
      providerId: "codex",
      name: "admin",
      config: {
        workingDirectory: "/workspace/allowed/team/../reviewer",
        permissions: { mode: "full-access", allowNetwork: true },
      },
    });

    expect((handle.agent as ExternalAgent).workingDirectory).toBe(
      "/workspace/allowed/reviewer",
    );
    expect((handle.agent as ExternalAgent).permissions).toEqual({
      mode: "full-access",
      allowNetwork: true,
    });
  });

  test("rejects traversal and sibling-prefix working directories", () => {
    const factory = new ExternalAgentWorkflowFactory({
      registry: registry(),
      policy: { workingDirectoryRoots: ["/workspace/root"] },
    });

    expectFactoryError(
      () =>
        factory.create({
          providerId: "codex",
          name: "traversal",
          config: { workingDirectory: "/workspace/root/../secrets" },
        }),
      "WORKFLOW_AGENT_POLICY_EXCEEDED",
    );
    expectFactoryError(
      () =>
        factory.create({
          providerId: "codex",
          name: "sibling",
          config: { workingDirectory: "/workspace/rootish" },
        }),
      "WORKFLOW_AGENT_POLICY_EXCEEDED",
    );
  });

  test("rejects allowed paths that escape policy roots", () => {
    const factory = new ExternalAgentWorkflowFactory({
      registry: registry(),
      policy: { workingDirectoryRoots: ["/workspace/root"] },
    });

    for (const [name, workingDirectory, allowedPath] of [
      ["filesystem_root", "/workspace/root", "/"],
      ["absolute_sibling", "/workspace/root", "/workspace/rootish"],
      ["relative_traversal", "/workspace/root/project", "../../secrets"],
    ] as const) {
      expectFactoryError(
        () =>
          factory.create({
            providerId: "codex",
            name,
            config: {
              workingDirectory,
              permissions: {
                mode: "workspace-write",
                allowedPaths: [allowedPath],
              },
            },
          }),
        "WORKFLOW_AGENT_POLICY_EXCEEDED",
      );
    }
  });

  test("requires an authorized working directory for relative allowed paths", () => {
    const factory = new ExternalAgentWorkflowFactory({
      registry: registry(),
      policy: { workingDirectoryRoots: ["/workspace/root"] },
    });

    expectFactoryError(
      () =>
        factory.create({
          providerId: "codex",
          name: "worker",
          config: {
            permissions: {
              mode: "workspace-write",
              allowedPaths: ["src"],
            },
          },
        }),
      "WORKFLOW_AGENT_POLICY_EXCEEDED",
    );
  });

  test("resolves valid relative allowed paths to normalized absolute paths", () => {
    const factory = new ExternalAgentWorkflowFactory({
      registry: registry(),
      policy: { workingDirectoryRoots: ["/workspace/root"] },
    });
    const handle = factory.create({
      providerId: "codex",
      name: "worker",
      config: {
        workingDirectory: "/workspace/root/project",
        permissions: {
          mode: "workspace-write",
          allowedPaths: ["src/../tests", "/workspace/root/shared", "tests"],
        },
      },
    });

    expect((handle.agent as ExternalAgent).permissions?.allowedPaths).toEqual([
      "/workspace/root/project/tests",
      "/workspace/root/shared",
    ]);
  });

  test("validates configured limits and permission payload bounds", () => {
    expectFactoryError(
      () =>
        new ExternalAgentWorkflowFactory({
          registry: registry(),
          limits: { maxAgents: 0 },
        }),
      "WORKFLOW_AGENT_INVALID_REQUEST",
    );

    const factory = new ExternalAgentWorkflowFactory({
      registry: registry(),
      limits: { maxAllowedPaths: 1 },
    });
    expectFactoryError(
      () =>
        factory.create({
          providerId: "codex",
          name: "worker",
          config: {
            permissions: {
              mode: "workspace-write",
              allowedPaths: ["src", "tests"],
            },
          },
        }),
      "WORKFLOW_AGENT_INVALID_REQUEST",
    );
  });
});

function expectFactoryError(
  operation: () => unknown,
  code: WorkflowAgentFactoryError["code"],
): void {
  try {
    operation();
    throw new Error("Expected workflow agent factory operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowAgentFactoryError);
    expect((error as WorkflowAgentFactoryError).code).toBe(code);
  }
}
