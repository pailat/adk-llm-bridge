/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

// Digests stored before 0.7.0 (localeCompare or insertion-order JSON) must
// keep validating after the switch to the canonical code-unit form.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BaseAgent,
  createEvent,
  type Event,
  InvocationContext,
} from "@google/adk";
import type { Content } from "@google/genai";
import { ExternalAgentDefinitionRegistry } from "../../src/agents/agent-registry.js";
import { PlaceholderExternalAgentDriver } from "../../src/agents/external-agent-driver.js";
import { ExternalAgentWorkflowFactory } from "../../src/workflows/agents/external-agent-workflow-factory.js";
import {
  createWorkflowCheckpoint,
  withWorkflowStepCompleted,
  withWorkflowStepRunning,
} from "../../src/workflows/checkpoint/checkpoint.js";
import { FileSystemWorkflowCheckpointStore } from "../../src/workflows/checkpoint/file-system-checkpoint-store.js";
import { hashWorkflowInput } from "../../src/workflows/checkpoint/hash.js";
import type { WorkflowCheckpointV1 } from "../../src/workflows/checkpoint/schema.js";
import {
  workflowCheckpointKey,
  workflowCheckpointRevision,
  workflowCheckpointRevisionMatches,
} from "../../src/workflows/checkpoint/store.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
import {
  InMemoryWorkflowArtifactStore,
  workflowArtifactRevisionMatches,
} from "../../src/workflows/resources/workflow-artifact-store.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";
import {
  createWorkflowChangeSet,
  verifyWorkflowChangeSet,
} from "../../src/workflows/workspace/change-driver.js";

const FILE_DIGEST = `sha256:${"a".repeat(64)}`;

/** Independent re-implementation of the pre-0.7.0 checkpoint hash. */
function localeDigest(value: unknown): string {
  const text =
    JSON.stringify(value, (_key, current) =>
      current && typeof current === "object" && !Array.isArray(current)
        ? Object.fromEntries(
            Object.entries(current).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          )
        : current,
    ) ?? "undefined";
  return sha256(text);
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

const userContent: Content = {
  role: "user",
  parts: [
    { text: "build it" },
    { functionResponse: { name: "lookup", response: { Beta: 1, alpha: 2 } } },
  ],
};

const stepInput: Content = {
  role: "user",
  parts: [{ functionResponse: { name: "plan", response: { Zed: 1, abc: 2 } } }],
};

class CountingAgent extends BaseAgent {
  calls = 0;

  constructor(name: string) {
    super({ name });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.calls++;
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: { role: "model", parts: [{ text: "fresh" }] },
    });
  }

  protected async *runLiveImpl() {}
}

function invocation(
  agent: BaseAgent,
  state: Record<string, unknown>,
): InvocationContext {
  return new InvocationContext({
    invocationId: "inv-legacy",
    branch: "root",
    agent,
    userContent,
    session: {
      id: "session-1",
      appName: "app",
      userId: "user",
      state,
      events: [],
      lastUpdateTime: 1,
    },
  });
}

async function collect(agent: BaseAgent, context: InvocationContext) {
  const events: Event[] = [];
  for await (const event of agent.runAsync(context)) events.push(event);
  return events;
}

function factoryRevision(): string {
  const factory = new ExternalAgentWorkflowFactory({
    registry: new ExternalAgentDefinitionRegistry([
      {
        provider: { id: "codex", name: "Codex" },
        createDriver: () => new PlaceholderExternalAgentDriver("codex"),
      },
    ]),
    policy: { workingDirectoryRoots: ["/workspace"], allowNetwork: true },
  });
  return factory.create({
    providerId: "codex",
    name: "worker_ext",
    config: {
      workingDirectory: "/workspace/w",
      permissions: {
        mode: "workspace-write",
        allowNetwork: true,
        allowedPaths: ["src"],
      },
    },
  }).descriptor.revision;
}

function legacyFactoryRevision(): string {
  return localeDigest({
    providerId: "codex",
    config: {
      workingDirectory: "/workspace/w",
      permissions: {
        mode: "workspace-write",
        allowNetwork: true,
        allowedPaths: ["/workspace/w/src"],
      },
    },
  });
}

async function legacyCheckpoint(
  definition: ReturnType<typeof defineWorkflow>,
  overrides: { stepInputHash?: string } = {},
): Promise<WorkflowCheckpointV1> {
  const step = {
    id: "implement",
    agentName: "worker",
    agentRevision: legacyFactoryRevision(),
    input: stepInput,
  };
  let checkpoint = await createWorkflowCheckpoint({
    definition,
    executionId: "inv-legacy",
    input: userContent,
    now: 10,
  });
  checkpoint = { ...checkpoint, inputHash: localeDigest(userContent) };
  checkpoint = withWorkflowStepRunning(
    checkpoint,
    step,
    overrides.stepInputHash ?? localeDigest(stepInput),
    1,
    10,
  );
  return withWorkflowStepCompleted(
    checkpoint,
    {
      status: "completed",
      id: step.id,
      agentName: step.agentName,
      output: "implemented",
      attempts: 1,
      startedAt: 10,
      completedAt: 20,
      replayed: false,
      // Mixed-case keys make the checkpoint revision differ between forms.
      stateDelta: { Beta: 1, alpha: 2 },
    },
    20,
  );
}

describe("legacy digest compatibility", () => {
  test("the fixtures exercise digests that differ between forms", async () => {
    expect(localeDigest(userContent)).not.toBe(
      await hashWorkflowInput(userContent),
    );
    expect(localeDigest(stepInput)).not.toBe(
      await hashWorkflowInput(stepInput),
    );
    expect(legacyFactoryRevision()).not.toBe(factoryRevision());
  });

  test("replays a step checkpointed with legacy input hashes and agent revision", async () => {
    const revision = factoryRevision();
    const worker = new CountingAgent("worker");
    const definition = defineWorkflow({
      id: "legacy-replay",
      version: "1",
      handler: async (ctx) =>
        (
          await ctx.run({
            id: "implement",
            agentName: "worker",
            agentRevision: revision,
            input: stepInput,
          })
        ).output,
    });
    const workflow = new WorkflowAgent({
      name: "workflow",
      definition,
      subAgents: [worker],
    });
    const key = workflowCheckpointKey("legacy-replay", "inv-legacy");
    const saved = await legacyCheckpoint(definition);

    const events = await collect(
      workflow,
      invocation(workflow, { [key]: saved }),
    );

    expect(worker.calls).toBe(0);
    expect(
      events.some(
        (event) =>
          (event.customMetadata?.workflowEvent as { type?: string } | undefined)
            ?.type === "step_replayed",
      ),
    ).toBe(true);
    const finalState = Object.assign(
      {},
      ...events.map((event) => event.actions?.stateDelta ?? {}),
    )[key] as WorkflowCheckpointV1;
    // Stored identities are kept, not rewritten.
    expect(finalState.inputHash).toBe(localeDigest(userContent));
    expect(finalState.steps.implement?.inputHash).toBe(localeDigest(stepInput));
    expect(finalState.steps.implement?.agentRevision).toBe(
      legacyFactoryRevision(),
    );
  });

  test("still rejects a stored step hash that matches neither form", async () => {
    const worker = new CountingAgent("worker");
    const definition = defineWorkflow({
      id: "legacy-mismatch",
      version: "1",
      handler: async (ctx) =>
        (
          await ctx.run({
            id: "implement",
            agentName: "worker",
            agentRevision: factoryRevision(),
            input: stepInput,
          })
        ).output,
    });
    const workflow = new WorkflowAgent({
      name: "workflow",
      definition,
      subAgents: [worker],
    });
    const key = workflowCheckpointKey("legacy-mismatch", "inv-legacy");
    const saved = await legacyCheckpoint(definition, {
      stepInputHash: sha256("something else"),
    });

    await expect(
      collect(workflow, invocation(workflow, { [key]: saved })),
    ).rejects.toMatchObject({ code: "WORKFLOW_STEP_MISMATCH" });
    expect(worker.calls).toBe(0);
  });

  test("new checkpoints get canonical hashes", async () => {
    const definition = defineWorkflow({
      id: "canonical",
      version: "1",
      handler: () => "done",
    });
    const checkpoint = await createWorkflowCheckpoint({
      definition,
      executionId: "e",
      input: userContent,
    });
    expect(checkpoint.inputHash).toBe(await hashWorkflowInput(userContent));
    expect(checkpoint.inputHash).not.toBe(localeDigest(userContent));
  });

  test("the file checkpoint store loads a file with a legacy revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "adk-legacy-checkpoint-"));
    try {
      const definition = defineWorkflow({
        id: "file-legacy",
        version: "1",
        handler: () => "done",
      });
      const checkpoint = await legacyCheckpoint(definition);
      const store = new FileSystemWorkflowCheckpointStore({ root });
      const context = {} as InvocationContext;
      await store.save({ context, checkpoint, expectedRevision: null });
      const path = await findJson(root);
      const envelope = JSON.parse(await readFile(path, "utf8"));
      const canonical = await workflowCheckpointRevision(envelope.checkpoint);
      const legacy = localeDigest(envelope.checkpoint);
      expect(envelope.revision).toBe(canonical);
      expect(legacy).not.toBe(canonical);
      expect(
        await workflowCheckpointRevisionMatches(envelope.checkpoint, legacy),
      ).toBe(true);

      // Rewrite the file as a pre-0.7.0 store would have written it.
      await writeFile(
        path,
        `${JSON.stringify({ ...envelope, revision: legacy })}\n`,
      );
      const loaded = await new FileSystemWorkflowCheckpointStore({
        root,
      }).load({
        context,
        workflowId: checkpoint.workflowId,
        executionId: checkpoint.executionId,
      });
      expect(loaded?.steps.implement?.inputHash).toBe(localeDigest(stepInput));
      // A conditional write against the canonical revision succeeds.
      await expect(
        store.save({ context, checkpoint, expectedRevision: canonical }),
      ).resolves.toBeDefined();

      await writeFile(
        path,
        `${JSON.stringify({ ...envelope, revision: sha256("forged") })}\n`,
      );
      await expect(
        store.load({
          context,
          workflowId: checkpoint.workflowId,
          executionId: checkpoint.executionId,
        }),
      ).rejects.toMatchObject({
        details: { reason: "checkpoint_revision_invalid" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("artifacts accept a legacy insertion-order revision", async () => {
    const store = new InMemoryWorkflowArtifactStore();
    const { artifact } = await store.put({
      artifactId: "report-1",
      executionId: "e",
      taskId: "t",
      type: "report",
      content: { Summary: "ok", details: [{ b: 1, a: 2 }], 10: 1, 9: 2 },
      metadata: { Owner: "x", kind: "y" },
    });
    const legacyContentDigest = sha256(JSON.stringify(artifact.content));
    const legacyRevision = sha256(
      JSON.stringify({
        artifactId: artifact.artifactId,
        executionId: artifact.executionId,
        taskId: artifact.taskId,
        type: artifact.type,
        content: artifact.content,
        metadata: artifact.metadata,
        contentDigest: legacyContentDigest,
      }),
    );

    expect(legacyRevision).not.toBe(artifact.revision);
    expect(
      await workflowArtifactRevisionMatches(artifact, legacyRevision),
    ).toBe(true);
    expect(
      await workflowArtifactRevisionMatches(artifact, artifact.revision),
    ).toBe(true);
    expect(
      await workflowArtifactRevisionMatches(artifact, sha256("forged")),
    ).toBe(false);
    expect(artifact.contentDigest).toBe(
      sha256('{"10":1,"9":2,"Summary":"ok","details":[{"a":2,"b":1}]}'),
    );
  });

  test("change sets verify with a legacy digest and sort entries by code unit", async () => {
    const input = {
      executionId: "execution-1",
      taskId: "task-1",
      planRevision: 3,
      workspaceRevision: "workspace-revision-1",
      baseRevision: "base-revision-1",
      entries: [
        {
          kind: "added" as const,
          path: "a.txt",
          entryKind: "file" as const,
          contentDigest: FILE_DIGEST,
        },
        {
          kind: "added" as const,
          path: "B.txt",
          entryKind: "file" as const,
          contentDigest: FILE_DIGEST,
        },
      ],
    };
    const changeSet = await createWorkflowChangeSet(input);
    expect(
      changeSet.entries.map((entry) => ("path" in entry ? entry.path : "")),
    ).toEqual(["B.txt", "a.txt"]);

    const { changeSetDigest: _digest, ...fields } = changeSet;
    const localeEntries = [...fields.entries].sort((left, right) =>
      ("path" in left ? left.path : "").localeCompare(
        "path" in right ? right.path : "",
      ),
    );
    const legacy = sha256(
      JSON.stringify({ ...fields, entries: localeEntries }),
    );
    expect(legacy).not.toBe(changeSet.changeSetDigest);

    const verified = await verifyWorkflowChangeSet({
      ...changeSet,
      changeSetDigest: legacy,
    });
    expect(verified.changeSetDigest).toBe(legacy);
    await expect(verifyWorkflowChangeSet(verified)).resolves.toBeDefined();
    await expect(verifyWorkflowChangeSet(changeSet)).resolves.toBeDefined();
    await expect(
      verifyWorkflowChangeSet({
        ...changeSet,
        changeSetDigest: sha256("forged"),
      }),
    ).rejects.toMatchObject({ code: "CHANGE_SET_DIGEST_MISMATCH" });
  });
});

async function findJson(root: string): Promise<string> {
  for (const shard of await readdir(root, { withFileTypes: true })) {
    if (!shard.isDirectory()) continue;
    const file = (await readdir(join(root, shard.name))).find((name) =>
      name.endsWith(".json"),
    );
    if (file) return join(root, shard.name, file);
  }
  throw new Error("checkpoint file not found");
}
