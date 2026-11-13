import { describe, expect, test } from "bun:test";
import {
  controlResult,
  EXECUTION_STATUSES,
  TASK_STATUSES,
} from "../../../src/workflows/control-plane/payloads.js";
import {
  WORKFLOW_CONTROL_PROTOCOL,
  WORKFLOW_CONTROL_PROTOCOL_VERSION,
  WorkflowControlPlane,
  WorkflowControlPlaneError,
} from "../../../src/workflows/control-plane/workflow-control-plane.js";
import type { WorkflowExecutionStatus } from "../../../src/workflows/execution/contracts.js";
import type { WorkflowTaskStatus } from "../../../src/workflows/tasks/contracts.js";

const envelope = {
  protocol: WORKFLOW_CONTROL_PROTOCOL,
  version: WORKFLOW_CONTROL_PROTOCOL_VERSION,
} as const;

interface Call {
  target: string;
  method: string;
  args: unknown[];
}

/** Recording stubs whose results come from `result(target, method)`. */
function harness(result: (target: string, method: string) => unknown) {
  const calls: Call[] = [];
  const stub = <T>(target: string): T =>
    new Proxy(
      {},
      {
        get: (_object, method) =>
          typeof method === "string"
            ? async (...args: unknown[]) => {
                calls.push({ target, method, args });
                return result(target, method);
              }
            : undefined,
      },
    ) as T;
  const control = new WorkflowControlPlane({
    executions: stub("executions"),
    tasks: stub("tasks"),
    artifacts: stub("artifacts"),
    integration: stub("integration"),
    dispatcher: stub("dispatcher"),
    trustedHostMode: true,
  });
  const dispatch = (operation: string, payload: unknown) =>
    control.dispatch({ ...envelope, operation, payload } as never);
  return { calls, dispatch };
}

describe("status tables", () => {
  // The tables are typed `Record<Union, true>`, so a status added to either
  // union fails to compile until it is listed. These lists pin the contents.
  const executionStatuses: readonly WorkflowExecutionStatus[] = [
    "queued",
    "running",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
  ];
  const taskStatuses: readonly WorkflowTaskStatus[] = [
    "queued",
    "running",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
  ];

  test("each table lists exactly its own union", () => {
    expect(Object.keys(EXECUTION_STATUSES).sort()).toEqual(
      [...executionStatuses].sort(),
    );
    expect(Object.keys(TASK_STATUSES).sort()).toEqual([...taskStatuses].sort());
  });

  test.each(executionStatuses)("execution.list accepts %s", async (status) => {
    const { calls, dispatch } = harness(() => ({ executions: [] }));
    await dispatch("execution.list", { status });
    expect(calls[0]?.args).toEqual([{ status }]);
  });

  test.each(taskStatuses)("task.list accepts %s", async (status) => {
    const { calls, dispatch } = harness(() => ({ tasks: [] }));
    await dispatch("task.list", { executionId: "e", status });
    expect(calls[0]?.args).toEqual([{ executionId: "e", status }]);
  });
});

describe("JSON fields are forwarded as the validated frozen copy", () => {
  test("execution.start input and metadata are copies, not the caller's objects", async () => {
    const { calls, dispatch } = harness(() => ({ ok: true }));
    const input = { nested: { value: 1 }, list: [1, 2] };
    const metadata = { team: "core" };
    await dispatch("execution.start", {
      executionId: "e",
      workflowId: "w",
      workflowVersion: "1",
      input,
      metadata,
    });
    const forwarded = calls[0]?.args[0] as {
      input: typeof input;
      metadata: typeof metadata;
    };
    expect(forwarded.input).toEqual(input);
    expect(forwarded.input).not.toBe(input);
    expect(forwarded.input.nested).not.toBe(input.nested);
    expect(Object.isFrozen(forwarded.input)).toBe(true);
    expect(Object.isFrozen(forwarded.input.nested)).toBe(true);
    expect(Object.isFrozen(forwarded.input.list)).toBe(true);
    expect(forwarded.metadata).not.toBe(metadata);
    // Later changes by the caller do not reach the forwarded value.
    input.nested.value = 2;
    expect(forwarded.input.nested.value).toBe(1);
  });

  test("a getter is read once: the controller sees the value that was checked", async () => {
    const { calls, dispatch } = harness(() => ({ ok: true }));
    let reads = 0;
    const payload = {
      get value() {
        reads++;
        // Valid on the first read, not JSON afterwards.
        return reads === 1 ? "checked" : Number.NaN;
      },
    };
    await dispatch("task.mailbox.send", {
      executionId: "e",
      taskId: "t",
      payload,
      operationId: "op",
    });
    const forwarded = calls[0]?.args[0] as { payload: { value: unknown } };
    expect(forwarded.payload.value).toBe("checked");
    expect(Object.getOwnPropertyDescriptor(forwarded.payload, "value")).toEqual(
      expect.objectContaining({ value: "checked", writable: false }),
    );
    expect(reads).toBe(1);
  });

  test("task.spawn input, artifact content and gate context are copies", async () => {
    const { calls, dispatch } = harness(() => ({ ok: true }));
    const input = { a: 1 };
    await dispatch("task.spawn", {
      executionId: "e",
      taskId: "t",
      agentId: "a",
      input,
      operationId: "op",
    });
    const content = { body: "x" };
    await dispatch("artifact.put", {
      artifactId: "art",
      executionId: "e",
      taskId: "t",
      type: "report",
      content,
    });
    const context = { reason: "ci" };
    await dispatch("integration.validate", {
      gateId: "g",
      executionId: "e",
      taskId: "t",
      artifacts: [],
      context,
    });
    const spawned = calls[0]?.args[0] as { input: unknown };
    const put = calls[1]?.args[0] as { content: unknown };
    const gate = calls[2]?.args[0] as { context: unknown };
    expect(spawned.input).toEqual(input);
    expect(spawned.input).not.toBe(input);
    expect(Object.isFrozen(spawned.input)).toBe(true);
    expect(put.content).toEqual(content);
    expect(put.content).not.toBe(content);
    expect(gate.context).toEqual(context);
    expect(gate.context).not.toBe(context);
  });

  test("undefined members are dropped, as the stores do", async () => {
    const { calls, dispatch } = harness(() => ({ ok: true }));
    await dispatch("execution.start", {
      executionId: "e",
      workflowId: "w",
      workflowVersion: "1",
      input: { kept: 1, dropped: undefined },
    });
    const forwarded = calls[0]?.args[0] as { input: object };
    expect(forwarded.input).toEqual({ kept: 1 });
    expect(Object.hasOwn(forwarded.input, "dropped")).toBe(false);
  });
});

describe("results are revalidated", () => {
  test("a valid result is returned as an equal, frozen copy", async () => {
    const record = { executionId: "e", status: "running", input: { a: [1] } };
    const { dispatch } = harness(() => record);
    const result = (await dispatch("execution.status", {
      executionId: "e",
    })) as typeof record;
    expect(result).toEqual(record);
    expect(result).not.toBe(record);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.input.a)).toBe(true);
  });

  test("artifact.get may return nothing", async () => {
    const { dispatch } = harness(() => undefined);
    await expect(
      dispatch("artifact.get", { executionId: "e", artifactId: "a" }),
    ).resolves.toBe(undefined);
  });

  const invalidResults: [string, unknown][] = [
    ["undefined", undefined],
    ["a primitive", "done"],
    ["an array where an object is expected", [{ ok: true }]],
    ["a class instance", new Date(0)],
    ["a non-finite number", { count: Number.NaN }],
    ["a function member", { run: () => 1 }],
    ["a map member", { items: new Map() }],
    ["a bigint member", { count: 1n }],
  ];

  test.each(invalidResults)(
    "execution.status rejects %s",
    async (_label, value) => {
      const { dispatch } = harness(() => value);
      const error = await dispatch("execution.status", {
        executionId: "e",
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(WorkflowControlPlaneError);
      expect((error as WorkflowControlPlaneError).code).toBe(
        "WORKFLOW_CONTROL_INVALID_RESULT",
      );
    },
  );

  test.each([
    ["undefined", undefined],
    ["no artifacts", {}],
    ["an object of artifacts", { artifacts: { a: { executionId: "e" } } }],
  ])("artifact.list rejects a page with %s", async (_label, value) => {
    const { dispatch } = harness(() => value);
    await expect(
      dispatch("artifact.list", { executionId: "e" }),
    ).rejects.toMatchObject({ code: "WORKFLOW_CONTROL_INVALID_RESULT" });
  });

  test("artifact.list drops null and primitive entries next to the request's artifacts", async () => {
    const own = { artifactId: "a", executionId: "e" };
    const { dispatch } = harness(() => ({
      artifacts: [null, own, "x", 7, { artifactId: "b", executionId: "f" }],
      nextCursor: "a",
    }));
    await expect(
      dispatch("artifact.list", { executionId: "e" }),
    ).resolves.toEqual({ artifacts: [own], nextCursor: "a" });
  });

  test("a cyclic result is rejected", async () => {
    const cyclic: Record<string, unknown> = { executionId: "e" };
    cyclic.self = cyclic;
    const { dispatch } = harness(() => cyclic);
    await expect(
      dispatch("execution.status", { executionId: "e" }),
    ).rejects.toMatchObject({ code: "WORKFLOW_CONTROL_INVALID_RESULT" });
  });

  test("list operations that return arrays must return arrays", () => {
    expect(controlResult("plan.list", [])).toEqual([]);
    expect(controlResult("ownership.list", [{ grantId: "g" }])).toEqual([
      { grantId: "g" },
    ]);
    expect(() => controlResult("plan.list", { plans: [] })).toThrow(
      expect.objectContaining({ code: "WORKFLOW_CONTROL_INVALID_RESULT" }),
    );
    expect(() => controlResult("ownership.list", undefined)).toThrow(
      expect.objectContaining({ code: "WORKFLOW_CONTROL_INVALID_RESULT" }),
    );
  });

  test("results are not capped by the request JSON limits", () => {
    // A page of records can exceed the 20,000-node request limit.
    const page = {
      tasks: Array.from({ length: 25_000 }, (_, index) => ({ index })),
    };
    expect(
      (controlResult("task.list", page) as typeof page).tasks,
    ).toHaveLength(25_000);
  });
});
