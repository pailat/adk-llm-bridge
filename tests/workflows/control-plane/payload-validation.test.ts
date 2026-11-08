/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  WORKFLOW_CONTROL_PROTOCOL,
  WORKFLOW_CONTROL_PROTOCOL_VERSION,
  WorkflowControlPlane,
} from "../../../src/workflows/control-plane/workflow-control-plane.js";
import { WorkflowActorContext } from "../../../src/workflows/orchestration/authorization.js";
import {
  WORKFLOW_PLAN_PROTOCOL,
  WORKFLOW_PLAN_VERSION,
} from "../../../src/workflows/orchestration/contracts.js";

const envelope = {
  protocol: WORKFLOW_CONTROL_PROTOCOL,
  version: WORKFLOW_CONTROL_PROTOCOL_VERSION,
} as const;

interface RecordedCall {
  target: string;
  method: string;
  args: unknown[];
}

/** Every service is a recording stub, so tests see exactly what was forwarded. */
function harness() {
  const calls: RecordedCall[] = [];
  const stub = <T>(target: string): T =>
    new Proxy(
      {},
      {
        get: (_object, method) =>
          typeof method === "string"
            ? async (...args: unknown[]) => {
                calls.push({ target, method, args });
                return { forwarded: method };
              }
            : undefined,
      },
    ) as T;
  const control = new WorkflowControlPlane({
    executions: stub("executions"),
    tasks: stub("tasks"),
    artifacts: stub("artifacts"),
    integration: stub("integration"),
    plans: stub("plans"),
    ownership: stub("ownership"),
    changeValidation: stub("changeValidation"),
    dispatcher: stub("dispatcher"),
    trustedHostMode: true,
  });
  // Trusted host mode serves task operations without an actor; plan and
  // ownership operations always need the host-authenticated actor.
  const dispatch = (
    operation: string,
    payload: unknown,
    actor: WorkflowActorContext | undefined = operation.startsWith("task.")
      ? undefined
      : ACTOR,
  ) =>
    control.dispatch(
      // Malformed requests are the point of these tests.
      { ...envelope, operation, payload } as never,
      { actor },
    );
  return { calls, dispatch };
}

const ACTOR = new WorkflowActorContext({
  actorId: "principal-coordinator",
  agentId: "coordinator",
  executionId: "execution-1",
  taskId: "integration",
  planRevision: 1,
});

const handle = { executionId: "execution-1", taskId: "review" };
const scope = { executionId: "execution-1", planRevision: 1 };
const digest = `sha256:${"a".repeat(64)}`;

function plan() {
  return {
    protocol: WORKFLOW_PLAN_PROTOCOL,
    version: WORKFLOW_PLAN_VERSION,
    executionId: "execution-1",
    planRevision: 1,
    baseRevision: "base-1",
    objective: "Validate every control payload",
    status: "ready",
    createdAt: 1,
    agents: [
      {
        agentId: "builder",
        policy: {
          role: "worker",
          permissions: ["plan:read", "ownership:claim"],
          canDelegate: false,
        },
        metadata: { team: "core" },
      },
      {
        agentId: "coordinator",
        policy: {
          role: "integration",
          permissions: ["plan:read", "changes:validate"],
          canDelegate: true,
          allowedDelegateRoles: ["worker"],
          maxChildren: 2,
        },
      },
    ],
    lanes: [
      {
        taskId: "implementation",
        agentId: "builder",
        role: "worker",
        ownedPaths: [{ path: "src/feature.ts", scope: "exact" }],
        mayCreateUnder: ["src/new"],
        dependsOn: [],
        acceptance: ["Focused tests pass"],
      },
    ],
    waves: [{ waveId: "wave-1", taskIds: ["implementation"] }],
    invariants: [
      {
        invariantId: "single-owner",
        description: "One owner per path",
        appliesTo: "ownership",
        enforcedBy: "control-plane",
      },
    ],
    reservedPaths: [{ path: "package.json", scope: "exact" }],
  };
}

type Plan = ReturnType<typeof plan>;

function planWith(change: (value: Plan) => void): Plan {
  const value = structuredClone(plan());
  change(value);
  return value;
}

function changeSet(entries: unknown[]) {
  return {
    executionId: "execution-1",
    taskId: "implementation",
    planRevision: 1,
    workspaceRevision: "workspace-1",
    baseRevision: "base-1",
    entries,
    changeSetDigest: digest,
  };
}

function validation(overrides: Record<string, unknown> = {}) {
  return {
    changeSet: changeSet([
      {
        kind: "modified",
        entryKind: "file",
        path: "src/feature.ts",
        contentDigest: digest,
      },
    ]),
    expectedBaseRevision: "base-1",
    expectedPlanRevision: 1,
    agentId: "builder",
    ownership: [{ grantId: "grant-1", fencingToken: 1 }],
    expectedTarget: { targetId: "integration", revision: "target-1" },
    ...overrides,
  };
}

function nested(depth: number): unknown {
  let value: unknown = "leaf";
  for (let index = 0; index < depth; index++) value = [value];
  return value;
}

function cyclic(): unknown {
  const value: Record<string, unknown> = {};
  value.self = value;
  return value;
}

describe("WorkflowControlPlane payload validation", () => {
  const forwarded: [
    operation: string,
    payload: unknown,
    target: string,
    method: string,
    args: unknown[],
  ][] = [
    [
      "execution.start",
      {
        executionId: "execution-1",
        workflowId: "implementation",
        workflowVersion: "1",
        input: { issue: [82, "x", null, true, 1.5] },
        metadata: { source: "json" },
      },
      "executions",
      "start",
      [
        {
          executionId: "execution-1",
          workflowId: "implementation",
          workflowVersion: "1",
          input: { issue: [82, "x", null, true, 1.5] },
          metadata: { source: "json" },
        },
      ],
    ],
    [
      "execution.resume",
      { executionId: "execution-1", strategy: "checkpoint" },
      "executions",
      "resume",
      [{ executionId: "execution-1", strategy: "checkpoint" }],
    ],
    [
      "execution.status",
      { executionId: "execution-1" },
      "executions",
      "status",
      ["execution-1"],
    ],
    [
      "execution.cancel",
      { executionId: "execution-1" },
      "executions",
      "cancel",
      ["execution-1"],
    ],
    ["execution.list", {}, "executions", "list", [{}]],
    [
      "execution.list",
      { status: "running", cursor: "", limit: 5 },
      "executions",
      "list",
      [{ status: "running", cursor: "", limit: 5 }],
    ],
    [
      "execution.events",
      {
        executionId: "execution-1",
        cursor: { executionId: "execution-1", afterSequence: 0 },
        limit: 10,
      },
      "executions",
      "events",
      [
        {
          executionId: "execution-1",
          cursor: { executionId: "execution-1", afterSequence: 0 },
          limit: 10,
        },
      ],
    ],
    [
      "task.spawn",
      { ...handle, agentId: "codex", input: { a: 1 }, operationId: "op-1" },
      "tasks",
      "spawn",
      [{ ...handle, agentId: "codex", input: { a: 1 } }],
    ],
    [
      "task.resume",
      { ...handle, strategy: "checkpoint" },
      "tasks",
      "resume",
      [{ ...handle, strategy: "checkpoint" }],
    ],
    ["task.dispatch", handle, "tasks", "dispatch", [handle]],
    ["task.recover", handle, "tasks", "recoverExpired", [handle]],
    [
      "task.sweep",
      { executionId: "execution-1", limit: 3, cursor: "" },
      "dispatcher",
      "sweep",
      [{ executionId: "execution-1", limit: 3, cursor: "" }],
    ],
    ["task.status", handle, "tasks", "status", [handle]],
    ["task.cancel", handle, "tasks", "cancel", [handle]],
    [
      "task.list",
      {
        executionId: "execution-1",
        parentTaskId: "root",
        agentId: "codex",
        status: "queued",
        cursor: "next",
        limit: 2,
      },
      "tasks",
      "list",
      [
        {
          executionId: "execution-1",
          parentTaskId: "root",
          agentId: "codex",
          status: "queued",
          cursor: "next",
          limit: 2,
        },
      ],
    ],
    ["task.join", handle, "tasks", "join", [handle, undefined]],
    [
      "task.awaitAny",
      { handles: [handle, { ...handle, taskId: "test" }] },
      "tasks",
      "awaitAny",
      [[handle, { ...handle, taskId: "test" }], undefined],
    ],
    [
      "task.mailbox.send",
      { ...handle, payload: ["any", { json: null }], operationId: "op-2" },
      "tasks",
      "send",
      [{ ...handle, payload: ["any", { json: null }] }],
    ],
    [
      "task.mailbox.read",
      {
        ...handle,
        cursor: { ...handle, afterSequence: 4 },
        limit: 1,
      },
      "tasks",
      "readMailbox",
      [{ ...handle, cursor: { ...handle, afterSequence: 4 }, limit: 1 }],
    ],
    [
      "task.mailbox.wait",
      handle,
      "tasks",
      "waitForMessages",
      [handle, undefined],
    ],
    [
      "artifact.put",
      {
        artifactId: "artifact-1",
        executionId: "execution-1",
        taskId: "review",
        type: "patch",
        content: "diff",
        metadata: { lines: 3 },
      },
      "artifacts",
      "put",
      [
        {
          artifactId: "artifact-1",
          executionId: "execution-1",
          taskId: "review",
          type: "patch",
          content: "diff",
          metadata: { lines: 3 },
        },
        { signal: undefined },
      ],
    ],
    [
      "artifact.get",
      { artifactId: "artifact-1" },
      "artifacts",
      "get",
      [{ artifactId: "artifact-1", signal: undefined }],
    ],
    [
      "artifact.list",
      { executionId: "execution-1", type: "patch", cursor: "", limit: 9 },
      "artifacts",
      "list",
      [
        {
          executionId: "execution-1",
          type: "patch",
          cursor: "",
          limit: 9,
          signal: undefined,
        },
      ],
    ],
    [
      "integration.validate",
      {
        gateId: "gate-1",
        executionId: "execution-1",
        taskId: "review",
        artifacts: [{ artifactId: "artifact-1", revision: "r1" }],
        context: { strict: true },
      },
      "integration",
      "validate",
      [
        {
          gateId: "gate-1",
          executionId: "execution-1",
          taskId: "review",
          artifacts: [{ artifactId: "artifact-1", revision: "r1" }],
          context: { strict: true },
        },
        { signal: undefined },
      ],
    ],
    ["plan.put", plan(), "plans", "put", [plan(), ACTOR]],
    ["plan.get", scope, "plans", "get", ["execution-1", 1, ACTOR]],
    ["plan.activate", scope, "plans", "activate", ["execution-1", 1, ACTOR]],
    [
      "plan.list",
      { executionId: "execution-1" },
      "plans",
      "list",
      ["execution-1", ACTOR],
    ],
    [
      "ownership.claim",
      { ...scope, claims: [{ path: "src", scope: "subtree" }] },
      "ownership",
      "claim",
      [{ ...scope, claims: [{ path: "src", scope: "subtree" }] }, ACTOR],
    ],
    [
      "ownership.propose",
      {
        ...scope,
        kind: "transfer",
        targetTaskId: "integration",
        sourceGrantId: "grant-1",
        claims: [],
      },
      "ownership",
      "propose",
      [
        {
          ...scope,
          kind: "transfer",
          targetTaskId: "integration",
          sourceGrantId: "grant-1",
          claims: [],
        },
        ACTOR,
      ],
    ],
    [
      "ownership.approve",
      { ...scope, proposalId: "proposal-1", reason: "ok" },
      "ownership",
      "approve",
      [{ ...scope, proposalId: "proposal-1", reason: "ok" }, ACTOR],
    ],
    [
      "ownership.reject",
      { ...scope, proposalId: "proposal-1" },
      "ownership",
      "reject",
      [{ ...scope, proposalId: "proposal-1" }, ACTOR],
    ],
    [
      "ownership.transfer",
      { ...scope, sourceGrantId: "grant-1", targetTaskId: "integration" },
      "ownership",
      "transfer",
      [
        { ...scope, sourceGrantId: "grant-1", targetTaskId: "integration" },
        ACTOR,
      ],
    ],
    [
      "ownership.release",
      { ...scope, grantId: "grant-1" },
      "ownership",
      "release",
      [{ ...scope, grantId: "grant-1" }, ACTOR],
    ],
    ["ownership.list", scope, "ownership", "list", [scope, ACTOR]],
    [
      "ownership.validate",
      validation(),
      "changeValidation",
      "validate",
      [validation(), ACTOR],
    ],
  ];

  test.each(forwarded)(
    "forwards a valid %s payload unchanged",
    async (operation, payload, target, method, args) => {
      const { calls, dispatch } = harness();
      await expect(dispatch(operation, payload)).resolves.toEqual({
        forwarded: method,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.target).toBe(target);
      expect(calls[0]?.method).toBe(method);
      expect(calls[0]?.args).toEqual(args);
    },
  );

  test("accepts change entries with a mode and renamed entries", async () => {
    const { calls, dispatch } = harness();
    const payload = validation({
      changeSet: changeSet([
        {
          kind: "added",
          entryKind: "file",
          mode: "100755",
          path: "bin/run",
          contentDigest: digest,
        },
        {
          kind: "renamed",
          entryKind: "symlink",
          mode: "120000",
          fromPath: "a",
          toPath: "b",
          contentDigest: digest,
        },
        {
          kind: "deleted",
          entryKind: "submodule",
          path: "vendor/lib",
          contentDigest: digest,
        },
      ]),
    });
    await dispatch("ownership.validate", payload);
    expect(calls[0]?.args[0]).toEqual(payload);
  });

  const rejected: [operation: string, payload: unknown, message: RegExp][] = [
    // execution
    [
      "execution.start",
      { executionId: "execution-1", workflowVersion: "1" },
      /execution start workflowId/,
    ],
    [
      "execution.start",
      { executionId: "", workflowId: "w", workflowVersion: "1" },
      /execution start executionId/,
    ],
    [
      "execution.start",
      { executionId: "e", workflowId: 1, workflowVersion: "1" },
      /execution start workflowId/,
    ],
    [
      "execution.start",
      { executionId: "e", workflowId: "w", workflowVersion: "1", extra: 1 },
      /execution start payload/,
    ],
    [
      "execution.start",
      {
        executionId: "e",
        workflowId: "w",
        workflowVersion: "1",
        input: Number.NaN,
      },
      /execution start input is invalid: JSON numbers must be finite/,
    ],
    [
      "execution.start",
      {
        executionId: "e",
        workflowId: "w",
        workflowVersion: "1",
        input: cyclic(),
      },
      /execution start input is invalid: JSON value must not contain cycles/,
    ],
    [
      "execution.start",
      {
        executionId: "e",
        workflowId: "w",
        workflowVersion: "1",
        input: { at: new Date(0) },
      },
      /execution start input is invalid: JSON objects must use a plain prototype/,
    ],
    [
      "execution.start",
      {
        executionId: "e",
        workflowId: "w",
        workflowVersion: "1",
        input: nested(40),
      },
      /execution start input is invalid: JSON value exceeds depth limit/,
    ],
    [
      "execution.start",
      { executionId: "e", workflowId: "w", workflowVersion: "1", metadata: [] },
      /execution start metadata is invalid/,
    ],
    [
      "execution.start",
      {
        executionId: "e",
        workflowId: "w",
        workflowVersion: "1",
        metadata: "x",
      },
      /execution start metadata is invalid/,
    ],
    [
      "execution.resume",
      { executionId: "e", strategy: "latest" },
      /execution resume strategy/,
    ],
    [
      "execution.resume",
      { strategy: "checkpoint" },
      /execution resume executionId/,
    ],
    [
      "execution.status",
      { executionId: "" },
      /execution identity payload is invalid/,
    ],
    ["execution.list", { status: "paused" }, /execution list status/],
    ["execution.list", { limit: 0 }, /execution list limit/],
    ["execution.list", { limit: 1.5 }, /execution list limit/],
    ["execution.list", { cursor: 3 }, /execution list cursor/],
    ["execution.list", { executionId: "e" }, /execution list payload/],
    [
      "execution.events",
      {
        executionId: "e",
        cursor: { executionId: "other", afterSequence: 0 },
      },
      /execution events cursor is invalid/,
    ],
    [
      "execution.events",
      { executionId: "e", cursor: { executionId: "e", afterSequence: -1 } },
      /execution events cursor afterSequence/,
    ],
    [
      "execution.events",
      {
        executionId: "e",
        cursor: { executionId: "e", afterSequence: 0, extra: true },
      },
      /execution events cursor payload/,
    ],
    [
      "execution.events",
      { executionId: "e", limit: "10" },
      /execution events limit/,
    ],
    // tasks
    ["task.spawn", { ...handle, agentId: "codex" }, /task spawn operationId/],
    [
      "task.spawn",
      {
        ...handle,
        agentId: "codex",
        operationId: "op",
        input: Number.POSITIVE_INFINITY,
      },
      /task spawn input is invalid/,
    ],
    ["task.resume", { ...handle, strategy: "latest" }, /task resume strategy/],
    ["task.dispatch", { executionId: "e" }, /task handle taskId/],
    ["task.awaitAny", { handles: [] }, /awaitAny handles are required/],
    ["task.awaitAny", { handles: "x" }, /awaitAny payload is invalid/],
    [
      "task.awaitAny",
      { handles: [{ executionId: "e" }] },
      /task handle taskId/,
    ],
    [
      "task.awaitAny",
      { handles: [handle, { executionId: "other", taskId: "t" }] },
      /handles must share an execution/,
    ],
    ["task.list", { executionId: "e", status: "paused" }, /task list status/],
    ["task.list", { executionId: "e", limit: -1 }, /task list limit/],
    [
      "task.mailbox.read",
      { ...handle, cursor: { ...handle, afterSequence: 1.5 } },
      /task mailbox cursor is invalid/,
    ],
    [
      "task.mailbox.read",
      { ...handle, cursor: { ...handle, taskId: "other", afterSequence: 1 } },
      /task mailbox cursor is invalid/,
    ],
    [
      "task.mailbox.send",
      { ...handle, operationId: "op" },
      /task mailbox send payload is invalid/,
    ],
    [
      "task.mailbox.send",
      { ...handle, operationId: "op", payload: undefined },
      /task mailbox send payload is invalid: Value must be JSON-safe/,
    ],
    [
      "task.mailbox.send",
      { ...handle, operationId: "op", payload: () => 1 },
      /task mailbox send payload is invalid/,
    ],
    ["task.sweep", { executionId: "e", limit: 0 }, /task sweep limit/],
    ["task.sweep", { executionId: "e", cursor: 1 }, /task sweep cursor/],
    // resources
    [
      "artifact.put",
      { artifactId: "a", executionId: "e", taskId: "t", type: "patch" },
      /artifact put content is invalid/,
    ],
    [
      "artifact.put",
      {
        artifactId: "a",
        executionId: "e",
        taskId: "t",
        type: "",
        content: 1,
      },
      /artifact put type/,
    ],
    [
      "artifact.put",
      {
        artifactId: "a",
        executionId: "e",
        taskId: "t",
        type: "patch",
        content: 1,
        metadata: [],
      },
      /artifact put metadata/,
    ],
    [
      "artifact.get",
      { artifactId: "" },
      /artifact identity payload is invalid/,
    ],
    ["artifact.list", { limit: 0 }, /artifact list limit/],
    ["artifact.list", { taskId: 3 }, /artifact list taskId/],
    [
      "integration.validate",
      { gateId: "g", executionId: "e", taskId: "t" },
      /integration gate artifacts/,
    ],
    [
      "integration.validate",
      {
        gateId: "g",
        executionId: "e",
        taskId: "t",
        artifacts: [{ artifactId: "a" }],
      },
      /integration artifact revision/,
    ],
    [
      "integration.validate",
      {
        gateId: "g",
        executionId: "e",
        taskId: "t",
        artifacts: [{ artifactId: "a", revision: "r", content: "x" }],
      },
      /integration artifact payload/,
    ],
    [
      "integration.validate",
      {
        gateId: "g",
        executionId: "e",
        taskId: "t",
        artifacts: [],
        context: [],
      },
      /integration gate context/,
    ],
    // plans
    [
      "plan.put",
      planWith((value) => {
        Object.assign(value, { protocol: "other" });
      }),
      /plan protocol/,
    ],
    [
      "plan.put",
      planWith((value) => {
        Object.assign(value, { version: 2 });
      }),
      /plan version/,
    ],
    [
      "plan.put",
      planWith((value) => {
        value.status = "done";
      }),
      /plan status/,
    ],
    [
      "plan.put",
      planWith((value) => {
        value.createdAt = -1;
      }),
      /plan createdAt/,
    ],
    [
      "plan.put",
      planWith((value) => {
        Object.assign(value, { agents: {} });
      }),
      /plan agents/,
    ],
    [
      "plan.put",
      planWith((value) => {
        Object.assign(value.agents[0]?.policy ?? {}, { role: "boss" });
      }),
      /plan agent policy role/,
    ],
    [
      "plan.put",
      planWith((value) => {
        value.agents[0]?.policy.permissions.push("root");
      }),
      /plan agent policy permission/,
    ],
    [
      "plan.put",
      planWith((value) => {
        Object.assign(value.agents[0]?.policy ?? {}, { canDelegate: "yes" });
      }),
      /plan agent policy canDelegate/,
    ],
    [
      "plan.put",
      planWith((value) => {
        Object.assign(value.agents[1]?.policy ?? {}, { maxChildren: 0 });
      }),
      /plan agent policy maxChildren/,
    ],
    [
      "plan.put",
      planWith((value) => {
        Object.assign(value.agents[0] ?? {}, { metadata: [] });
      }),
      /plan agent metadata/,
    ],
    [
      "plan.put",
      planWith((value) => {
        Object.assign(value.lanes[0] ?? {}, { role: "boss" });
      }),
      /plan lane role/,
    ],
    [
      "plan.put",
      planWith((value) => {
        Object.assign(value.lanes[0] ?? {}, { mayCreateUnder: [1] });
      }),
      /plan lane mayCreateUnder/,
    ],
    [
      "plan.put",
      planWith((value) => {
        Object.assign(value.waves[0] ?? {}, { taskIds: "implementation" });
      }),
      /plan wave taskIds/,
    ],
    [
      "plan.put",
      planWith((value) => {
        Object.assign(value.invariants[0] ?? {}, { appliesTo: "everything" });
      }),
      /plan invariant appliesTo/,
    ],
    [
      "plan.put",
      planWith((value) => {
        Object.assign(value.reservedPaths[0] ?? {}, { scope: "deep" });
      }),
      /plan reserved paths claim scope/,
    ],
    [
      "plan.get",
      { executionId: "e", planRevision: 0 },
      /plan get planRevision/,
    ],
    // ownership
    ["ownership.claim", { ...scope, claims: [] }, /claims are required/],
    [
      "ownership.claim",
      { ...scope, claims: [{ path: "src", scope: "deep" }] },
      /ownership claim claim scope/,
    ],
    [
      "ownership.propose",
      { ...scope, kind: "steal" },
      /ownership proposal kind/,
    ],
    ["ownership.approve", scope, /ownership decision proposalId/],
    [
      "ownership.transfer",
      { ...scope, sourceGrantId: "g" },
      /ownership transfer targetTaskId/,
    ],
    [
      "ownership.release",
      { ...scope, grantId: 1 },
      /ownership release grantId/,
    ],
    [
      "ownership.validate",
      validation({ ownership: [{ grantId: "g", fencingToken: 0 }] }),
      /ownership validation fencingToken/,
    ],
    [
      "ownership.validate",
      validation({
        changeSet: changeSet([
          {
            kind: "copied",
            entryKind: "file",
            path: "a",
            contentDigest: digest,
          },
        ]),
      }),
      /change entry kind/,
    ],
    [
      "ownership.validate",
      validation({
        changeSet: changeSet([
          {
            kind: "added",
            entryKind: "socket",
            path: "a",
            contentDigest: digest,
          },
        ]),
      }),
      /change entry entryKind/,
    ],
    [
      "ownership.validate",
      validation({
        changeSet: changeSet([
          {
            kind: "added",
            entryKind: "file",
            mode: "100600",
            path: "a",
            contentDigest: digest,
          },
        ]),
      }),
      /change entry mode/,
    ],
    [
      "ownership.validate",
      validation({
        changeSet: changeSet([
          {
            kind: "renamed",
            entryKind: "file",
            fromPath: "a",
            contentDigest: digest,
          },
        ]),
      }),
      /change entry toPath/,
    ],
    [
      "ownership.validate",
      validation({
        changeSet: changeSet([
          {
            kind: "renamed",
            entryKind: "file",
            path: "a",
            fromPath: "a",
            toPath: "b",
            contentDigest: digest,
          },
        ]),
      }),
      /change entry payload/,
    ],
    [
      "ownership.validate",
      validation({
        changeSet: { ...changeSet([]), changeSetDigest: undefined },
      }),
      /change set changeSetDigest/,
    ],
    [
      "ownership.validate",
      validation({ expectedTarget: undefined }),
      /expected target payload/,
    ],
  ];

  test.each(rejected)(
    "rejects an invalid %s payload before any service call",
    async (operation, payload, message) => {
      const { calls, dispatch } = harness();
      const error = await dispatch(operation, payload).catch(
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({
        name: "WorkflowControlPlaneError",
        code: "WORKFLOW_CONTROL_INVALID_REQUEST",
      });
      expect((error as Error).message).toMatch(message);
      expect(calls).toHaveLength(0);
    },
  );

  test("derives the mailbox sender from the actor after validation", async () => {
    const { calls, dispatch } = harness();
    await dispatch(
      "task.mailbox.send",
      { ...handle, payload: { note: 1 }, operationId: "op-3" },
      ACTOR,
    );
    expect(calls[0]?.args).toEqual([
      { ...handle, senderTaskId: "integration", payload: { note: 1 } },
      { actor: ACTOR, operationId: "op-3" },
    ]);
  });

  test("still reports unknown operations after envelope validation", async () => {
    const { calls, dispatch } = harness();
    await expect(dispatch("task.teleport", {})).rejects.toMatchObject({
      code: "WORKFLOW_CONTROL_UNKNOWN_OPERATION",
      message: "Unknown workflow control operation: task.teleport",
    });
    await expect(dispatch("task.teleport", [])).rejects.toMatchObject({
      code: "WORKFLOW_CONTROL_INVALID_REQUEST",
    });
    expect(calls).toHaveLength(0);
  });
});
