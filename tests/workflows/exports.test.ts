import { describe, expect, test } from "bun:test";
import packageJson from "../../package.json" with { type: "json" };
import * as root from "../../src/index.js";
import type {
  WorkflowAgentDescriptor,
  WorkflowAgentFactory,
  WorkflowAgentHandle,
  WorkflowChangeAuthorityErrorCode,
  WorkflowChangeMismatchErrorCode,
  WorkflowCheckpointFailureReason,
  WorkflowControlPlaneErrorCode,
  WorkflowExecutionRecordErrorCode,
  WorkflowScriptHost,
  WorkflowTaskRecordErrorCode,
  WorkflowWorkspaceConfig,
  WorkspaceAdapter,
} from "../../src/workflows/index.js";
import * as workflows from "../../src/workflows/index.js";
import * as workflowNode from "../../src/workflows/node/index.js";
import * as workflowSpec from "../../src/workflows/spec/index.js";

describe("workflows public exports", () => {
  test("root export remains LLM-focused", () => {
    expect(root.OpenAI).toBeFunction();
    expect("WorkflowAgent" in root).toBe(false);
    expect("ScriptWorkflowAgent" in root).toBe(false);
  });

  test("./workflows exposes the first-class workflow surface", () => {
    // ADK primitives are imported from "@google/adk", not re-exported here.
    expect("BaseAgent" in workflows).toBe(false);
    expect(workflows.WorkflowAgent).toBeFunction();
    expect(workflows.WorkflowInterruptedError).toBeFunction();
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
    expect(workflows.QUICKJS_MAX_STACK_BYTES).toBe(32 * 1024);
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
    expect(workflows.WorkflowPlanController).toBeFunction();
    expect(workflows.WorkflowOwnershipController).toBeFunction();
    expect(workflows.WorkflowOrchestrationTaskAuthorityPort).toBeFunction();
    expect(workflows.WorkflowOwnershipChangeSetValidator).toBeFunction();
    expect(workflows.WorkflowLiveChangeReceiptAuthority).toBeFunction();
    expect(workflows.WorkflowTaskDispatcher).toBeFunction();
    expect(workflows.AdkWorkflowTaskDriver).toBeFunction();
    expect(workflows.AgentInvocationGateway).toBeFunction();
    expect(workflows.WorkflowValidatedCommitter).toBeFunction();
    expect(workflows.WorkflowValidatedIntegrator).toBeFunction();
    expect(workflows.InMemoryWorkflowHostMutationJournal).toBeFunction();
    expect(workflows.InMemoryWorkspaceProvisioner).toBeFunction();
    expect(workflows.InMemoryWorkflowArtifactStore).toBeFunction();
    expect(workflows.WorkflowArtifactIdentityError).toBeFunction();
    expect(workflows.workflowArtifactStoragePath).toBeFunction();
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

  test("./workflows exports the error code and failure reason unions as types", () => {
    // A Record keyed by each union fails to type-check when a member is added
    // or removed, so these lists track the public unions.
    const controlCodes: Record<WorkflowControlPlaneErrorCode, true> = {
      WORKFLOW_CONTROL_INVALID_REQUEST: true,
      WORKFLOW_CONTROL_UNAUTHORIZED: true,
      WORKFLOW_CONTROL_UNKNOWN_OPERATION: true,
      WORKFLOW_CONTROL_CAPABILITY_UNAVAILABLE: true,
      WORKFLOW_CONTROL_INVALID_RESULT: true,
    };
    const executionRecordCodes: Record<WorkflowExecutionRecordErrorCode, true> =
      {
        WORKFLOW_EXECUTION_FAILED: true,
        WORKFLOW_EXECUTION_CANCELLED: true,
      };
    const taskRecordCodes: Record<WorkflowTaskRecordErrorCode, true> = {
      WORKFLOW_TASK_DRIVER_FAILED: true,
      WORKFLOW_TASK_CANCELLED: true,
      WORKFLOW_TASK_DISPATCH_FAILED: true,
    };
    const reason: WorkflowCheckpointFailureReason | undefined = undefined;
    const mismatch: WorkflowChangeMismatchErrorCode = "CHANGE_RECEIPT_MISMATCH";
    const authority: WorkflowChangeAuthorityErrorCode =
      "WORKFLOW_CHANGE_AUTHORITY_REQUIRED";
    const host: WorkflowScriptHost | undefined = undefined;

    expect(Object.keys(controlCodes)).toContain(
      "WORKFLOW_CONTROL_UNAUTHORIZED",
    );
    expect(Object.keys(executionRecordCodes)).toHaveLength(2);
    expect(Object.keys(taskRecordCodes)).toHaveLength(3);
    expect([reason, host]).toEqual([undefined, undefined]);
    expect([mismatch, authority]).toEqual([
      "CHANGE_RECEIPT_MISMATCH",
      "WORKFLOW_CHANGE_AUTHORITY_REQUIRED",
    ]);
    expect("WorkflowScriptHost" in workflows).toBe(false);
  });

  test("package exports publishes the workflows subpath", () => {
    expect(packageJson.exports["./workflows"]).toEqual({
      types: "./dist/workflows/index.d.ts",
      import: "./dist/workflows/index.js",
    });
    expect(packageJson.exports["./workflows/node"]).toEqual({
      types: "./dist/workflows/node/index.d.ts",
      import: "./dist/workflows/node/index.js",
    });
    expect(workflowNode.NodeGitWorktreeChangeDriver).toBeFunction();
  });

  test.each([
    "immutableJson",
    "immutableTaskJson",
    "immutableWorkflowOrchestrationJson",
    "DEFAULT_WORKFLOW_EXECUTION_JSON_LIMITS",
    "DEFAULT_WORKFLOW_TASK_JSON_LIMITS",
    "DEFAULT_WORKFLOW_ORCHESTRATION_JSON_LIMITS",
    "validateExecutionId",
    "validateIdentifier",
    "validateTaskHandle",
    "isTerminalTaskStatus",
    "workflowCheckpointKey",
    "toDurableWorkflowCheckpoint",
    "isWorkflowCheckpointV1",
    "canonicalJson",
    "optionalJsonObject",
    "requiredResourceIdentity",
    "snapshotJson",
    "throwIfResourceAborted",
    "workflowMutationReservations",
    "validateWorkflowPath",
    "verifyWorkflowChangeSet",
    "normalizeAuthoritativeIntegrationRequest",
    "requireWorkflowActorContext",
    "unauthorized",
    "isWorkflowIdentifier",
    "normalizePortablePath",
    "portablePathProblem",
  ])("./workflows does not export the internal %s", (name) => {
    expect(name in workflows).toBe(false);
    expect(name in workflowNode).toBe(false);
  });

  test("./workflows/node exports only the Git worktree driver surface", () => {
    expect(Object.keys(workflowNode).sort()).toEqual([
      "FileSystemWorkflowRepositoryMutationLock",
      "NodeGitWorktreeChangeDriver",
      "NodeGitWorktreeError",
    ]);
  });

  test("./workflows does not export the JSON limit types", () => {
    type Removed = [
      // @ts-expect-error Removed from the public surface in 0.7.
      workflows.WorkflowExecutionJsonLimits,
      // @ts-expect-error Removed from the public surface in 0.7.
      workflows.WorkflowTaskJsonLimits,
      // @ts-expect-error Removed from the public surface in 0.7.
      workflows.WorkflowOrchestrationJsonLimits,
    ];
    const removed: Removed | undefined = undefined;
    expect(removed).toBeUndefined();
  });

  test("the barrels list their exports explicitly", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const root = join(import.meta.dir, "../../src/workflows");
    const barrels = [
      "index.ts",
      ...(await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(entry.name, "index.ts")),
    ];
    for (const barrel of barrels) {
      const source = await readFile(join(root, barrel), "utf8").catch(() => "");
      expect({
        barrel,
        star: /^export (type )?\* from/mu.test(source),
      }).toEqual({
        barrel,
        star: false,
      });
    }
  });
  test("package exports publishes the experimental spec subpath", () => {
    expect(packageJson.exports["./workflows/spec"]).toEqual({
      types: "./dist/workflows/spec/index.d.ts",
      import: "./dist/workflows/spec/index.js",
    });
  });

  test("the spec subpath exposes exactly the value exports of its barrel", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const source = await readFile(
      join(import.meta.dir, "../../src/workflows/spec/index.ts"),
      "utf8",
    );
    const declared = [
      ...source.matchAll(/export\s*\{([^}]*)\}\s*from/gu),
      // Type-only export lists are skipped below.
    ]
      .filter((match) => !/export\s+type\s*\{/u.test(match[0]))
      .flatMap((match) =>
        (match[1] ?? "")
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0 && !name.startsWith("type "))
          .map((name) => name.split(/\s+as\s+/u).pop() as string),
      );
    expect(declared.length).toBeGreaterThan(0);
    expect(Object.keys(workflowSpec).sort()).toEqual([...declared].sort());
    expect(workflowSpec.RunSpecSchema).toBeDefined();
    expect(workflowSpec.validateRunSpec).toBeFunction();
  });

  test("the spec subpath keeps its internal projection helpers private", () => {
    // resolveRunPlan already returns their results: the topology, each
    // lane's agent runs and the QA command allowlist check.
    for (const name of [
      "runSpecPlanTopology",
      "runSpecLaneMaxAgentRuns",
      "runSpecCommandKey",
    ]) {
      expect({ name, exported: name in workflowSpec }).toEqual({
        name,
        exported: false,
      });
    }
  });

  test("the spec values do not leak into the other entries", () => {
    for (const name of Object.keys(workflowSpec)) {
      expect({ name, inWorkflows: name in workflows }).toEqual({
        name,
        inWorkflows: false,
      });
      expect({ name, inRoot: name in root }).toEqual({ name, inRoot: false });
    }
  });

  test("the spec barrel has no star exports", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const source = await readFile(
      join(import.meta.dir, "../../src/workflows/spec/index.ts"),
      "utf8",
    );
    expect(/^export (type )?\*/mu.test(source)).toBe(false);
  });
});
