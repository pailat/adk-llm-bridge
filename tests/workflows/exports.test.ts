/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import { BaseAgent } from "@google/adk";
import packageJson from "../../package.json";
import * as root from "../../src/index.js";
import type {
  WorkflowAgentDescriptor,
  WorkflowAgentFactory,
  WorkflowAgentHandle,
  WorkflowWorkspaceConfig,
  WorkspaceAdapter,
} from "../../src/workflows/index.js";
import * as workflows from "../../src/workflows/index.js";

describe("workflows public exports", () => {
  test("root export remains LLM-focused", () => {
    expect(root.OpenAI).toBeFunction();
    expect("WorkflowAgent" in root).toBe(false);
    expect("ScriptWorkflowAgent" in root).toBe(false);
  });

  test("./workflows exposes the first-class workflow surface", () => {
    expect(workflows.BaseAgent).toBe(BaseAgent);
    expect(workflows.WorkflowAgent).toBeFunction();
    expect(workflows.ScriptWorkflowAgent).toBeFunction();
    expect(workflows.defineWorkflow).toBeFunction();
    expect(workflows.defineScriptWorkflow).toBeFunction();
    expect(workflows.WorkflowDefinitionRegistry).toBeFunction();
    expect(workflows.ADKSessionCheckpointStore).toBeFunction();
    expect(workflows.FileSystemWorkflowCheckpointStore).toBeFunction();
    expect(
      workflows.collectFileSystemCheckpointTombstonesOffline,
    ).toBeFunction();
    expect(workflows.QuickJSSyncGeneratorRuntime).toBeFunction();
    expect(workflows.runWorkflowScript).toBeFunction();
    expect(workflows.ExternalAgentWorkflowFactory).toBeFunction();
    expect(workflows.WorkflowAgentFactoryError).toBeFunction();
    expect(workflows.DEFAULT_WORKFLOW_AGENT_FACTORY_LIMITS).toBeObject();
    expect(workflows.WorkflowExecutionController).toBeFunction();
    expect(workflows.InMemoryWorkflowExecutionStore).toBeFunction();
    expect(workflows.InMemoryWorkflowExecutionEventStore).toBeFunction();
    expect(workflows.WorkflowTaskController).toBeFunction();
    expect(workflows.InMemoryWorkflowTaskStore).toBeFunction();
    expect(workflows.InMemoryWorkflowTaskMessageStore).toBeFunction();
    expect(workflows.WorkflowControlPlane).toBeFunction();
    expect(workflows.InMemoryWorkspaceProvisioner).toBeFunction();
    expect(workflows.InMemoryWorkflowArtifactStore).toBeFunction();
    expect(workflows.IntegrationGate).toBeFunction();
    expect(workflows.InMemoryWorkspaceAdapter).toBeFunction();
    expect(workflows.FileSystemWorkspaceAdapter).toBeFunction();
    expect(
      workflows.collectFileSystemWorkspaceTombstonesOffline,
    ).toBeFunction();
    expect(workflows.normalizeWorkspacePath).toBeFunction();
    expect(workflows.normalizeWorkspaceLeaseRequest).toBeFunction();
    expect(workflows.workspacePathsOverlap).toBeFunction();
    expect(workflows.findWorkspacePathOverlaps).toBeFunction();
  });

  test("./workflows keeps host contracts and agent handles type-only", () => {
    const adapter: WorkspaceAdapter = new workflows.InMemoryWorkspaceAdapter({
      createLeaseId: () => "lease-1",
      now: () => 1,
    });
    const workspace = {
      workspaceId: "repository",
      adapter,
    } satisfies WorkflowWorkspaceConfig;
    const descriptor = {
      providerId: "codex",
      name: "reviewer",
      revision: "sha256:revision",
    } satisfies WorkflowAgentDescriptor;
    const listDescriptors = (factory: WorkflowAgentFactory) => factory.list();
    const getHostAgent = (handle: WorkflowAgentHandle) => handle.agent;

    expect(workspace.adapter).toBe(adapter);
    expect(descriptor).toEqual({
      providerId: "codex",
      name: "reviewer",
      revision: "sha256:revision",
    });
    expect(listDescriptors).toBeFunction();
    expect(getHostAgent).toBeFunction();
    expect("WorkspaceAdapter" in workflows).toBe(false);
    expect("WorkflowWorkspaceConfig" in workflows).toBe(false);
    expect("WorkflowAgentFactory" in workflows).toBe(false);
    expect("WorkflowAgentHandle" in workflows).toBe(false);
  });

  test("package exports publishes the workflows subpath", () => {
    expect(packageJson.exports["./workflows"]).toEqual({
      types: "./dist/workflows/index.d.ts",
      import: "./dist/workflows/index.js",
    });
  });
});
