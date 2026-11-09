import { describe, expect, test } from "bun:test";
import {
  WORKFLOW_CONTROL_PROTOCOL,
  WORKFLOW_CONTROL_PROTOCOL_VERSION,
  WorkflowControlPlane,
} from "../../../src/workflows/control-plane/workflow-control-plane.js";
import { WorkflowActorContext } from "../../../src/workflows/orchestration/authorization.js";
import { IntegrationGate } from "../../../src/workflows/resources/integration-gate.js";
import {
  InMemoryWorkflowArtifactStore,
  type WorkflowArtifactStore,
} from "../../../src/workflows/resources/workflow-artifact-store.js";

const envelope = {
  protocol: WORKFLOW_CONTROL_PROTOCOL,
  version: WORKFLOW_CONTROL_PROTOCOL_VERSION,
} as const;

const digest = `sha256:${"a".repeat(64)}`;

/** A valid payload and a stub result for every operation under test. */
const OPERATIONS: Record<string, { payload: unknown; result: unknown }> = {
  "execution.start": {
    payload: {
      executionId: "execution-1",
      workflowId: "implementation",
      workflowVersion: "1",
    },
    result: { executionId: "execution-1" },
  },
  "execution.resume": {
    payload: { executionId: "execution-1", strategy: "checkpoint" },
    result: { executionId: "execution-1" },
  },
  "execution.status": {
    payload: { executionId: "execution-1" },
    result: { executionId: "execution-1" },
  },
  "execution.cancel": {
    payload: { executionId: "execution-1" },
    result: { executionId: "execution-1" },
  },
  "execution.list": { payload: {}, result: { executions: [] } },
  "execution.events": {
    payload: { executionId: "execution-1" },
    result: { events: [] },
  },
  "artifact.put": {
    payload: {
      artifactId: "artifact-1",
      executionId: "execution-1",
      taskId: "review",
      type: "patch",
      content: { diff: "" },
    },
    result: { artifactId: "artifact-1", executionId: "execution-1" },
  },
  "artifact.get": {
    payload: { executionId: "execution-1", artifactId: "artifact-1" },
    result: { artifactId: "artifact-1", executionId: "execution-1" },
  },
  "artifact.list": {
    payload: { executionId: "execution-1" },
    result: { artifacts: [] },
  },
  "integration.validate": {
    payload: {
      gateId: "gate-1",
      executionId: "execution-1",
      taskId: "review",
      artifacts: [{ artifactId: "artifact-1", revision: digest }],
    },
    result: { verdict: "accepted" },
  },
};

interface HarnessOptions {
  trustedHostMode?: boolean;
  /** Results of successive `artifact.get` calls; the last one repeats. */
  artifacts?: unknown[];
  /** Error thrown by `artifact.put`. */
  putError?: unknown;
}

function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const stub = <T>(target: string): T =>
    new Proxy(
      {},
      {
        get: (_object, method) =>
          typeof method === "string"
            ? async () => {
                const operation =
                  target === "integration"
                    ? "integration.validate"
                    : `${target}.${method}`;
                calls.push(operation);
                if (operation === "artifact.get" && options.artifacts) {
                  return options.artifacts.length > 1
                    ? options.artifacts.shift()
                    : options.artifacts[0];
                }
                if (operation === "artifact.put" && options.putError) {
                  throw options.putError;
                }
                return OPERATIONS[operation]?.result ?? {};
              }
            : undefined,
      },
    ) as T;
  const control = new WorkflowControlPlane({
    executions: stub("execution"),
    tasks: stub("task"),
    artifacts: stub("artifact"),
    integration: stub("integration"),
    ...(options.trustedHostMode === undefined
      ? {}
      : { trustedHostMode: options.trustedHostMode }),
  });
  const dispatch = (
    operation: string,
    payload: unknown,
    actor?: WorkflowActorContext,
  ) =>
    control.dispatch({ ...envelope, operation, payload } as never, {
      ...(actor === undefined ? {} : { actor }),
    });
  return { calls, dispatch };
}

function actor(executionId = "execution-1", taskId?: string) {
  return new WorkflowActorContext({
    actorId: "principal-1",
    agentId: "codex",
    executionId,
    ...(taskId === undefined ? {} : { taskId }),
  });
}

async function errorCode(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => "resolved",
    (error: { code?: unknown }) => error.code,
  );
}

describe("execution, artifact and integration authorization", () => {
  for (const [operation, { payload }] of Object.entries(OPERATIONS)) {
    test(`${operation} without an actor is unauthorized by default`, async () => {
      const { calls, dispatch } = harness();
      expect(await errorCode(dispatch(operation, payload))).toBe(
        "WORKFLOW_CONTROL_UNAUTHORIZED",
      );
      expect(calls).toEqual([]);
    });

    test(`${operation} without an actor works in trusted host mode`, async () => {
      const { calls, dispatch } = harness({ trustedHostMode: true });
      await dispatch(operation, payload);
      expect(calls).toEqual([operation]);
    });

    test(`${operation} with a forged actor object is unauthorized`, async () => {
      const { calls, dispatch } = harness();
      const forged = { identity: { executionId: "execution-1" } };
      expect(
        await errorCode(dispatch(operation, payload, forged as never)),
      ).toBe("WORKFLOW_CONTROL_UNAUTHORIZED");
      expect(calls).toEqual([]);
    });
  }

  const EXECUTION_OPERATIONS = [
    "execution.start",
    "execution.resume",
    "execution.status",
    "execution.cancel",
    "execution.events",
  ];

  for (const operation of EXECUTION_OPERATIONS) {
    test(`${operation} with an execution-level actor is forwarded`, async () => {
      const { calls, dispatch } = harness();
      await dispatch(operation, OPERATIONS[operation]?.payload, actor());
      expect(calls).toEqual([operation]);
    });

    test(`${operation} with a task-bound actor is unauthorized`, async () => {
      const { calls, dispatch } = harness();
      expect(
        await errorCode(
          dispatch(
            operation,
            OPERATIONS[operation]?.payload,
            actor("execution-1", "review"),
          ),
        ),
      ).toBe("WORKFLOW_CONTROL_UNAUTHORIZED");
      expect(calls).toEqual([]);
    });
  }

  for (const [operation, expected] of [
    ["artifact.put", ["artifact.put"]],
    ["artifact.get", ["artifact.get"]],
    ["artifact.list", ["artifact.list"]],
    ["integration.validate", ["integration.validate"]],
  ] as const) {
    test(`${operation} with a task-bound actor of the same execution is forwarded`, async () => {
      const { calls, dispatch } = harness();
      await dispatch(
        operation,
        OPERATIONS[operation]?.payload,
        actor("execution-1", "review"),
      );
      expect(calls).toEqual([...expected]);
    });
  }

  for (const operation of [
    "execution.start",
    "execution.resume",
    "execution.status",
    "execution.cancel",
    "execution.events",
    "artifact.put",
    "artifact.list",
    "integration.validate",
  ]) {
    test(`${operation} for another execution is unauthorized before the service runs`, async () => {
      const { calls, dispatch } = harness();
      expect(
        await errorCode(
          dispatch(
            operation,
            OPERATIONS[operation]?.payload,
            actor("execution-2"),
          ),
        ),
      ).toBe("WORKFLOW_CONTROL_UNAUTHORIZED");
      expect(calls).toEqual([]);
    });
  }

  test("execution.list needs trusted host mode even with an actor", async () => {
    const { calls, dispatch } = harness();
    expect(await errorCode(dispatch("execution.list", {}, actor()))).toBe(
      "WORKFLOW_CONTROL_UNAUTHORIZED",
    );
    expect(calls).toEqual([]);
  });

  for (const trustedHostMode of [false, true]) {
    test(`artifact.list without an execution id is an invalid request (trustedHostMode: ${trustedHostMode})`, async () => {
      const { calls, dispatch } = harness({ trustedHostMode });
      expect(
        await errorCode(dispatch("artifact.list", { type: "patch" }, actor())),
      ).toBe("WORKFLOW_CONTROL_INVALID_REQUEST");
      expect(calls).toEqual([]);
    });

    test(`artifact.get without an execution id is an invalid request (trustedHostMode: ${trustedHostMode})`, async () => {
      const { calls, dispatch } = harness({ trustedHostMode });
      expect(
        await errorCode(
          dispatch("artifact.get", { artifactId: "artifact-1" }, actor()),
        ),
      ).toBe("WORKFLOW_CONTROL_INVALID_REQUEST");
      expect(calls).toEqual([]);
    });
  }

  test("artifact.get for another execution reads as absent and never reaches the store", async () => {
    const { calls, dispatch } = harness();
    await expect(
      dispatch(
        "artifact.get",
        OPERATIONS["artifact.get"]?.payload,
        actor("execution-2"),
      ),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("artifact.get fails closed on a store that returns another execution's artifact", async () => {
    for (const trustedHostMode of [false, true]) {
      const { dispatch } = harness({
        trustedHostMode,
        artifacts: [{ artifactId: "artifact-1", executionId: "execution-2" }],
      });
      await expect(
        dispatch("artifact.get", OPERATIONS["artifact.get"]?.payload, actor()),
      ).resolves.toBeUndefined();
    }
  });

  test("artifact.get that finds nothing still resolves undefined for an actor", async () => {
    const { dispatch } = harness({ artifacts: [undefined] });
    await expect(
      dispatch("artifact.get", OPERATIONS["artifact.get"]?.payload, actor()),
    ).resolves.toBeUndefined();
  });

  for (const operation of ["artifact.put", "integration.validate"]) {
    test(`${operation} under another task of the actor's execution is unauthorized`, async () => {
      const { calls, dispatch } = harness();
      expect(
        await errorCode(
          dispatch(
            operation,
            OPERATIONS[operation]?.payload,
            actor("execution-1", "other-task"),
          ),
        ),
      ).toBe("WORKFLOW_CONTROL_UNAUTHORIZED");
      expect(calls).toEqual([]);
    });
  }

  test("artifact.put keeps the store error for a conflict inside the actor's execution", async () => {
    const conflict = new Error("conflict");
    const { dispatch } = harness({ putError: conflict });
    await expect(
      dispatch(
        "artifact.put",
        OPERATIONS["artifact.put"]?.payload,
        actor("execution-1", "review"),
      ),
    ).rejects.toBe(conflict);
  });

  test("an invalid payload is still reported as an invalid request", async () => {
    const { dispatch } = harness();
    expect(
      await errorCode(dispatch("execution.status", { executionId: 1 })),
    ).toBe("WORKFLOW_CONTROL_INVALID_REQUEST");
  });
});

describe("artifact ids across executions with the in-memory store", () => {
  function setup() {
    const artifacts = new InMemoryWorkflowArtifactStore();
    const stub = <T>(): T =>
      new Proxy({}, { get: () => async () => ({}) }) as T;
    const control = new WorkflowControlPlane({
      executions: stub(),
      tasks: stub(),
      artifacts,
      integration: new IntegrationGate(artifacts, {
        validate: async () => ({ verdict: "accepted", result: null }),
      }),
    });
    const put = async (executionId: string, content: unknown) =>
      (await control.dispatch(
        {
          ...envelope,
          operation: "artifact.put",
          payload: {
            artifactId: "shared-id",
            executionId,
            taskId: "review",
            type: "patch",
            content,
          },
        } as never,
        { actor: actor(executionId, "review") },
      )) as { created: boolean; artifact: { revision: string } };
    const get = (
      executionId: string,
      artifactId: string,
      as = actor(executionId),
    ) =>
      control.dispatch(
        {
          ...envelope,
          operation: "artifact.get",
          payload: { executionId, artifactId },
        },
        { actor: as },
      ) as Promise<{ content: unknown } | undefined>;
    return { artifacts, control, get, put };
  }

  test("the same id in two executions never overwrites", async () => {
    const { get, put } = setup();
    const second = await put("execution-2", { owner: "b" });
    const first = await put("execution-1", { owner: "a" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect((await get("execution-1", "shared-id"))?.content).toEqual({
      owner: "a",
    });
    expect((await get("execution-2", "shared-id"))?.content).toEqual({
      owner: "b",
    });
  });

  test("another execution's artifact and a missing id read the same", async () => {
    const { get, put } = setup();
    await put("execution-2", { owner: "b" });
    const caller = actor("execution-1");

    await expect(
      get("execution-2", "shared-id", caller),
    ).resolves.toBeUndefined();
    await expect(
      get("execution-2", "missing-id", caller),
    ).resolves.toBeUndefined();
    await expect(
      get("execution-1", "shared-id", caller),
    ).resolves.toBeUndefined();
  });

  test("integration.validate cannot probe another execution's artifact", async () => {
    const { control, put } = setup();
    const { revision } = (await put("execution-2", { owner: "b" })).artifact;
    const validate = (artifactId: string, candidate: string) =>
      control
        .dispatch(
          {
            ...envelope,
            operation: "integration.validate",
            payload: {
              gateId: "gate-1",
              executionId: "execution-1",
              taskId: "review",
              artifacts: [{ artifactId, revision: candidate }],
            },
          },
          { actor: actor("execution-1", "review") },
        )
        .then(
          () => "resolved",
          (error: Error) => error.message.replace(artifactId, "<id>"),
        );
    const stale = `sha256:${"c".repeat(64)}`;
    const missing = await validate("missing-id", revision);
    expect(await validate("shared-id", revision)).toBe(missing);
    expect(await validate("shared-id", stale)).toBe(missing);
  });
});

describe("artifact.list with a store that ignores the execution", () => {
  async function legacySetup(trustedHostMode: boolean) {
    const inner = new InMemoryWorkflowArtifactStore();
    for (const executionId of ["execution-1", "execution-2", "execution-1"]) {
      await inner.put({
        artifactId: `${executionId}-${(await inner.list({ executionId })).artifacts.length}`,
        executionId,
        taskId: "review",
        type: "patch",
        content: executionId,
      });
    }
    const everything = async () => [
      ...(await inner.list({ executionId: "execution-1" })).artifacts,
      ...(await inner.list({ executionId: "execution-2" })).artifacts,
    ];
    const legacy: WorkflowArtifactStore = {
      put: (input) => inner.put(input),
      get: (input) => inner.get(input),
      // Not re-keyed: ignores the execution and returns every record.
      list: async () => ({ artifacts: await everything(), nextCursor: "next" }),
    };
    const stub = <T>(): T =>
      new Proxy({}, { get: () => async () => ({}) }) as T;
    const control = new WorkflowControlPlane({
      executions: stub(),
      tasks: stub(),
      artifacts: legacy,
      integration: new IntegrationGate(legacy, {
        validate: async () => ({ verdict: "accepted", result: null }),
      }),
      trustedHostMode,
    });
    return (executionId: string) =>
      control.dispatch(
        { ...envelope, operation: "artifact.list", payload: { executionId } },
        trustedHostMode ? {} : { actor: actor(executionId) },
      ) as Promise<{
        artifacts: { executionId: string; artifactId: string }[];
        nextCursor?: string;
      }>;
  }

  for (const trustedHostMode of [false, true]) {
    test(`drops other executions' artifacts and keeps the cursor (trustedHostMode: ${trustedHostMode})`, async () => {
      const list = await legacySetup(trustedHostMode);
      const page = await list("execution-1");
      expect(page.artifacts.map(({ artifactId }) => artifactId)).toEqual([
        "execution-1-0",
        "execution-1-1",
      ]);
      expect(page.nextCursor).toBe("next");
      const other = await list("execution-2");
      expect(other.artifacts.map(({ executionId }) => executionId)).toEqual([
        "execution-2",
      ]);
    });
  }
});
