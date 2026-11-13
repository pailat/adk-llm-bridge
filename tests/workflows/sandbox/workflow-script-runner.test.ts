import { describe, expect } from "bun:test";
import type {
  WorkflowStep,
  WorkflowStepOutcome,
  WorkflowStepResult,
} from "../../../src/workflows/contracts.js";
import type { WorkflowUserEvent } from "../../../src/workflows/events.js";
import type { WorkflowScriptHost } from "../../../src/workflows/sandbox/protocol.js";
import {
  WORKFLOW_SCRIPT_PROTOCOL,
  WORKFLOW_SCRIPT_PROTOCOL_VERSION,
} from "../../../src/workflows/sandbox/protocol.js";
import { QuickJSSyncGeneratorRuntime } from "../../../src/workflows/sandbox/quickjs-generator-runtime.js";
import type {
  WorkflowScriptGeneratorTurn,
  WorkflowScriptRuntime,
} from "../../../src/workflows/sandbox/types.js";
import { runWorkflowScript } from "../../../src/workflows/sandbox/workflow-script-runner.js";
import { fromPartial } from "../../helpers/partial.js";
// Every test here gets a deadline and the host-blocking watchdog.
import { sandboxTest as test } from "../../helpers/sandbox-test.js";

function result(step: WorkflowStep, output: string): WorkflowStepResult {
  return {
    status: "completed",
    id: step.id,
    agentName: step.agentName,
    output,
    attempts: 1,
    startedAt: 1,
    completedAt: 2,
  };
}

function createHost(log: string[]): WorkflowScriptHost {
  return {
    async run(step) {
      log.push(`run:${step.id}:${step.input}`);
      return result(step, `output:${step.id}`);
    },
    async parallel(steps, options): Promise<WorkflowStepOutcome[]> {
      log.push(
        `parallel:${steps.map((step) => step.id).join(",")}:${options?.failureMode ?? "default"}`,
      );
      return steps.map((step) => result(step, `output:${step.id}`));
    },
    emit(event) {
      log.push(`emit:${event.name}:${String(event.data)}`);
    },
  };
}

describe("runWorkflowScript", () => {
  test("bridges multiple run, parallel, emit, and final turns", async () => {
    const log: string[] = [];
    const execution = await runWorkflowScript(
      new QuickJSSyncGeneratorRuntime(),
      {
        input: { parts: [{ text: "build feature" }] },
        source: `
          const plan = yield ctx.run({
            id: "plan",
            agentName: "planner",
            input: ctx.inputText,
          });
          yield ctx.emit({ type: "custom", name: "planned", data: plan.output });
          const implementations = yield ctx.parallel([
            { id: "left", agentName: "codex", input: plan.output },
            { id: "right", agentName: "codex", input: plan.output },
          ], { failureMode: "all-settled", concurrency: 2 });
          const review = yield ctx.run({
            id: "review",
            agentName: "reviewer",
            input: implementations.map((item) => item.output).join(","),
          });
          return review.output;
        `,
        host: createHost(log),
      },
    );

    expect(execution).toEqual({
      output: "output:review",
      steps: 4,
      messages: 4,
    });
    expect(log).toEqual([
      "run:plan:build feature",
      "emit:planned:output:plan",
      "parallel:left,right:all-settled",
      "run:review:output:left,output:right",
    ]);
  });

  test("projects single-step results without mutating host event history", async () => {
    const events = fromPartial<WorkflowStepResult["events"]>([
      { author: "agent", content: { parts: [{ text: "internal" }] } },
    ]);
    const hostResult: WorkflowStepResult = {
      status: "completed",
      id: "single",
      agentName: "agent",
      output: "visible",
      content: { parts: [{ text: "visible" }] },
      events,
      stateDelta: { approved: true },
      attempts: 2,
      startedAt: 10,
      completedAt: 20,
      replayed: true,
    };
    const host = createHost([]);
    host.run = async () => hostResult;

    const execution = await runWorkflowScript(
      new QuickJSSyncGeneratorRuntime(),
      {
        source: `
          const value = yield ctx.run({
            id: "single",
            agentName: "agent",
            input: "go",
          });
          return JSON.stringify(value);
        `,
        host,
      },
    );

    expect(JSON.parse(execution.output as string)).toEqual({
      status: "completed",
      id: "single",
      agentName: "agent",
      output: "visible",
      content: { parts: [{ text: "visible" }] },
      stateDelta: { approved: true },
      attempts: 2,
      startedAt: 10,
      completedAt: 20,
      replayed: true,
    });
    expect(hostResult.events).toBe(events);
    expect(hostResult).toHaveProperty("events", events);
  });

  test("projects completed parallel outcomes and preserves failures", async () => {
    const host = createHost([]);
    host.parallel = async (steps): Promise<WorkflowStepOutcome[]> => {
      const [left, right] = steps;
      if (!left || !right) {
        throw new Error("expected two parallel steps");
      }
      return [
        {
          ...result(left, "left output"),
          events: fromPartial<WorkflowStepResult["events"]>([
            { author: "left" },
          ]),
        },
        {
          status: "failed",
          id: right.id,
          agentName: right.agentName,
          error: {
            code: "WORKFLOW_EXECUTION_ERROR",
            message: "right failed",
            details: { retryable: false },
          },
          attempts: 1,
          startedAt: 1,
          completedAt: 3,
        },
      ];
    };

    const execution = await runWorkflowScript(
      new QuickJSSyncGeneratorRuntime(),
      {
        source: `
          const values = yield ctx.parallel([
            { id: "left", agentName: "agent", input: "left" },
            { id: "right", agentName: "agent", input: "right" },
          ], { failureMode: "all-settled" });
          return JSON.stringify(values);
        `,
        host,
      },
    );

    expect(JSON.parse(execution.output as string)).toEqual([
      {
        status: "completed",
        id: "left",
        agentName: "agent",
        output: "left output",
        attempts: 1,
        startedAt: 1,
        completedAt: 2,
      },
      {
        status: "failed",
        id: "right",
        agentName: "agent",
        error: {
          code: "WORKFLOW_EXECUTION_ERROR",
          message: "right failed",
          details: { retryable: false },
        },
        attempts: 1,
        startedAt: 1,
        completedAt: 3,
      },
    ]);
  });

  test("keeps large host event histories outside the sandbox payload", async () => {
    const history = fromPartial<WorkflowStepResult["events"]>(
      Array.from({ length: 32 }, (_, index) => ({
        author: `agent-${index}`,
        content: { parts: [{ text: "x".repeat(128) }] },
      })),
    );
    const host = createHost([]);
    host.parallel = async (steps) =>
      steps.map((step) => ({
        ...result(step, `output:${step.id}`),
        events: history,
      }));

    const execution = await runWorkflowScript(
      new QuickJSSyncGeneratorRuntime(),
      {
        source: `
          const values = yield ctx.parallel([
            { id: "left", agentName: "agent", input: "left" },
            { id: "right", agentName: "agent", input: "right" },
          ]);
          return values.map((value) => value.output).join(",");
        `,
        host,
        limits: { maxMessageBytes: 512 },
      },
    );

    expect(execution.output).toBe("output:left,output:right");
    expect(history).toHaveLength(32);
  });

  test("bridges dynamic agent operations without exposing host handles", async () => {
    const log: string[] = [];
    const host = createHost(log);
    host.spawnAgent = async (request) => {
      log.push(`spawn:${request.providerId}:${request.name}`);
      return {
        providerId: request.providerId,
        name: request.name,
        revision: "sha256:worker-v1",
        agent: { secret: "host-handle" },
        credential: "host-secret",
      } as never;
    };
    host.listAgents = async () => [
      {
        providerId: "codex",
        name: "worker",
        revision: "sha256:worker-v1",
        agent: { secret: "host-handle" },
      } as never,
    ];
    let releases = 0;
    host.releaseAgent = async (name) => {
      log.push(`release:${name}`);
      releases++;
      return releases === 1;
    };

    const execution = await runWorkflowScript(
      new QuickJSSyncGeneratorRuntime(),
      {
        source: `
          const spawned = yield ctx.spawnAgent({
            providerId: "codex",
            name: "worker",
            config: { instruction: "implement" },
          });
          const listed = yield ctx.listAgents();
          const released = yield ctx.releaseAgent("worker");
          const releasedAgain = yield ctx.releaseAgent("worker");
          return JSON.stringify({ spawned, listed, released, releasedAgain });
        `,
        host,
      },
    );

    expect(JSON.parse(execution.output as string)).toEqual({
      spawned: {
        providerId: "codex",
        name: "worker",
        revision: "sha256:worker-v1",
      },
      listed: [
        {
          providerId: "codex",
          name: "worker",
          revision: "sha256:worker-v1",
        },
      ],
      released: true,
      releasedAgain: false,
    });
    expect(execution.messages).toBe(4);
    expect(log).toEqual([
      "spawn:codex:worker",
      "release:worker",
      "release:worker",
    ]);
    expect(execution.output).not.toContain("host-secret");
    expect(execution.output).not.toContain("host-handle");
  });

  test.each([
    ["malformed", "yield { nope: true };", "unsupported RPC protocol"],
    [
      "unknown",
      `yield { protocol: "adk-llm-bridge/workflow-rpc", version: 1, op: "nope" };`,
      "unknown operation",
    ],
    ["bad run", "yield ctx.run({ id: 1 });", "malformed run operation"],
    [
      "bad parallel",
      "yield ctx.parallel([{ id: 'x' }]);",
      "malformed parallel operation",
    ],
    [
      "bad emit",
      "yield ctx.emit({ type: 'custom' });",
      "malformed emit operation",
    ],
    [
      "bad spawn",
      `yield ctx.spawnAgent({ providerId: "codex", name: "worker", secret: true });`,
      "malformed spawnAgent operation",
    ],
    [
      "bad spawn permissions",
      `yield ctx.spawnAgent({ providerId: "codex", name: "worker", config: { permissions: { mode: "read-only", secret: true } } });`,
      "malformed spawnAgent operation",
    ],
    [
      "bad list",
      `yield { protocol: "adk-llm-bridge/workflow-rpc", version: 1, op: "listAgents", extra: true };`,
      "malformed listAgents operation",
    ],
    [
      "bad release",
      `yield { protocol: "adk-llm-bridge/workflow-rpc", version: 1, op: "releaseAgent", name: 1 };`,
      "malformed releaseAgent operation",
    ],
  ])("rejects %s operations", async (_name, source, message) => {
    await expect(
      runWorkflowScript(new QuickJSSyncGeneratorRuntime(), {
        source,
        host: createHost([]),
      }),
    ).rejects.toThrow(message);
  });

  test("enforces total steps and yielded message count", async () => {
    const source = `
      yield ctx.emit({ type: "custom", name: "one" });
      yield ctx.emit({ type: "custom", name: "two" });
      return "done";
    `;
    await expect(
      runWorkflowScript(new QuickJSSyncGeneratorRuntime(), {
        source,
        host: createHost([]),
        maxMessages: 1,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_LIMIT_EXCEEDED" });

    await expect(
      runWorkflowScript(new QuickJSSyncGeneratorRuntime(), {
        source: `
          yield ctx.parallel([
            { id: "one", agentName: "agent", input: "one" },
            { id: "two", agentName: "agent", input: "two" },
          ]);
        `,
        host: createHost([]),
        limits: { maxSteps: 1 },
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_LIMIT_EXCEEDED" });
  });

  test("a replaying host may answer steps past maxSteps from its checkpoint", async () => {
    const log: string[] = [];
    const host = createHost(log);
    const run = host.run;
    host.run = async (step) => ({
      ...(await run(step)),
      replayed: step.id.startsWith("old"),
    });
    const execution = await runWorkflowScript(
      new QuickJSSyncGeneratorRuntime(),
      {
        source: `
          for (const id of ["old1", "old2", "old3", "new1"]) {
            yield ctx.run({ id, agentName: "agent", input: id });
          }
          return "done";
        `,
        host,
        limits: { maxSteps: 1, maxReplayedSteps: 3 },
        replaysFromCheckpoint: true,
      },
    );

    expect(execution).toMatchObject({ output: "done", steps: 4 });
  });

  test("a replaying host owns the per-kind bounds; the runner enforces their sum across calls", async () => {
    const log: string[] = [];
    await expect(
      runWorkflowScript(new QuickJSSyncGeneratorRuntime(), {
        source: `
          for (const id of ["one", "two", "three"]) {
            yield ctx.run({ id, agentName: "agent", input: id });
          }
        `,
        // The host reports every step as executed; the runner does not
        // second-guess that classification.
        host: createHost(log),
        limits: { maxSteps: 1, maxReplayedSteps: 1 },
        replaysFromCheckpoint: true,
      }),
    ).rejects.toMatchObject({
      code: "WORKFLOW_LIMIT_EXCEEDED",
      details: {
        limit: 2,
        limitName: "maxSteps + maxReplayedSteps",
        stepId: "three",
        requestedSteps: 2,
        maxSteps: 1,
        maxReplayedSteps: 1,
      },
    });
    expect(log).toEqual(["run:one:one", "run:two:two"]);
  });

  test("a replaying host is not asked for a request past both step limits", async () => {
    const log: string[] = [];
    await expect(
      runWorkflowScript(new QuickJSSyncGeneratorRuntime(), {
        source: `
          yield ctx.parallel([
            { id: "one", agentName: "agent", input: "1" },
            { id: "two", agentName: "agent", input: "2" },
            { id: "three", agentName: "agent", input: "3" },
          ]);
        `,
        host: createHost(log),
        limits: { maxSteps: 1, maxReplayedSteps: 1 },
        replaysFromCheckpoint: true,
      }),
    ).rejects.toMatchObject({
      code: "WORKFLOW_LIMIT_EXCEEDED",
      details: {
        limit: 2,
        limitName: "maxSteps + maxReplayedSteps",
        stepId: "three",
        requestedSteps: 0,
      },
    });
    expect(log).toEqual([]);
  });

  test("without replaysFromCheckpoint every requested step counts toward maxSteps before the host runs it", async () => {
    const log: string[] = [];
    const host = createHost(log);
    const run = host.run;
    host.run = async (step) => ({ ...(await run(step)), replayed: true });
    await expect(
      runWorkflowScript(new QuickJSSyncGeneratorRuntime(), {
        source: `
          yield ctx.run({ id: "one", agentName: "agent", input: "1" });
          yield ctx.run({ id: "two", agentName: "agent", input: "2" });
        `,
        host,
        limits: { maxSteps: 1 },
      }),
    ).rejects.toMatchObject({
      code: "WORKFLOW_LIMIT_EXCEEDED",
      details: {
        limit: 1,
        limitName: "maxSteps",
        stepId: "two",
        executedSteps: 1,
        replayedSteps: 0,
        maxSteps: 1,
        maxReplayedSteps: 10,
      },
    });
    expect(log).toEqual(["run:one:1"]);
  });

  test("the default message bound includes maxReplayedSteps for a replaying host", async () => {
    const source = `
      for (let i = 0; i < 4; i++) yield ctx.emit({ type: "custom", name: "e", data: i });
      return "done";
    `;
    // maxSteps 1: 3 messages without replays, 2 * (1 + 10) + 1 with them.
    await expect(
      runWorkflowScript(new QuickJSSyncGeneratorRuntime(), {
        source,
        host: createHost([]),
        limits: { maxSteps: 1 },
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_LIMIT_EXCEEDED" });
    await expect(
      runWorkflowScript(new QuickJSSyncGeneratorRuntime(), {
        source,
        host: createHost([]),
        limits: { maxSteps: 1 },
        replaysFromCheckpoint: true,
      }),
    ).resolves.toMatchObject({ output: "done" });
  });

  test("enforces the active dynamic agent limit", async () => {
    const host = createHost([]);
    host.spawnAgent = async ({ providerId, name }) => ({
      providerId,
      name,
      revision: "sha256:test",
    });

    await expect(
      runWorkflowScript(new QuickJSSyncGeneratorRuntime(), {
        source: `
          yield ctx.spawnAgent({ providerId: "codex", name: "one" });
          yield ctx.spawnAgent({ providerId: "codex", name: "two" });
        `,
        host,
        maxAgents: 1,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_LIMIT_EXCEEDED" });
  });

  test("aborts while awaiting a host operation and disposes the VM", async () => {
    const controller = new AbortController();
    let disposed = 0;
    const runtime = new QuickJSSyncGeneratorRuntime({
      onDispose: () => {
        disposed += 1;
      },
    });
    const host = createHost([]);
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    host.run = async () => {
      markStarted();
      return await new Promise<WorkflowStepResult>(() => {});
    };
    const execution = runWorkflowScript(runtime, {
      source: `yield ctx.run({ id: "wait", agentName: "agent", input: "wait" });`,
      signal: controller.signal,
      host,
    });
    await started;
    controller.abort();
    await expect(execution).rejects.toMatchObject({ code: "WORKFLOW_ABORTED" });
    expect(disposed).toBe(1);
  });

  test("does not expose host globals and rejects imports", async () => {
    const execution = await runWorkflowScript(
      new QuickJSSyncGeneratorRuntime(),
      {
        source: `
          return [typeof Bun, typeof process, typeof require, typeof fetch]
            .join(",");
        `,
        host: createHost([]),
      },
    );
    expect(execution.output).toBe("undefined,undefined,undefined,undefined");

    await expect(
      runWorkflowScript(new QuickJSSyncGeneratorRuntime(), {
        source: `return import("node:fs");`,
        host: createHost([]),
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_SCRIPT_INVALID" });
  });

  test("rejects invalid final output and oversized host responses", async () => {
    await expect(
      runWorkflowScript(new QuickJSSyncGeneratorRuntime(), {
        source: "return { arbitrary: true };",
        host: createHost([]),
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_SCRIPT_INVALID" });

    const host = createHost([]);
    host.run = async (step) => result(step, "x".repeat(1024));
    await expect(
      runWorkflowScript(new QuickJSSyncGeneratorRuntime(), {
        source: `
          yield ctx.run({ id: "large", agentName: "agent", input: "go" });
          return "done";
        `,
        host,
        limits: { maxMessageBytes: 256 },
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_LIMIT_EXCEEDED" });
  });

  test("maps host failures without exposing host objects", async () => {
    const host = createHost([]);
    host.emit = (_event: WorkflowUserEvent) => {
      throw new Error("sensitive object failed");
    };
    await expect(
      runWorkflowScript(new QuickJSSyncGeneratorRuntime(), {
        source: `yield ctx.emit({ type: "custom", name: "event" });`,
        host,
      }),
    ).rejects.toMatchObject({
      code: "WORKFLOW_EXECUTION_ERROR",
      message: expect.stringContaining("sensitive object failed"),
    });
  });

  test("keeps the host messages intact when the guest replaces JSON or the generator", async () => {
    const log: string[] = [];
    const execution = await runWorkflowScript(
      new QuickJSSyncGeneratorRuntime(),
      {
        source: `
          JSON.stringify = () => "null";
          JSON.parse = () => ({ done: true });
          Reflect.apply = () => ({ done: true, value: "forged" });
          Object.getPrototypeOf(function* () {}).prototype.next = () => ({
            done: true,
            value: "forged",
          });
          const step = yield ctx.run({ id: "plan", agentName: "planner", input: "go" });
          return step.output;
        `,
        host: createHost(log),
      },
    );

    expect(execution.output).toBe("output:plan");
    expect(log).toEqual(["run:plan:go"]);
  });

  test("rejects malformed Content in a step input before the host sees it", async () => {
    for (const input of [
      "{ parts: [null] }",
      "{ parts: [5] }",
      "{ parts: [[]] }",
      '{ role: 5, parts: [{ text: "x" }] }',
    ]) {
      const log: string[] = [];
      await expect(
        runWorkflowScript(new QuickJSSyncGeneratorRuntime(), {
          source: `
            yield ctx.run({ id: "plan", agentName: "planner", input: ${input} });
            return "done";
          `,
          host: createHost(log),
        }),
      ).rejects.toMatchObject({ code: "WORKFLOW_SCRIPT_INVALID" });
      expect(log).toEqual([]);
    }
  });

  test("rejects malformed Content as final output", async () => {
    for (const output of [
      "{ parts: [null] }",
      "{ parts: [5] }",
      '{ role: [], parts: [{ text: "x" }] }',
    ]) {
      await expect(
        runWorkflowScript(new QuickJSSyncGeneratorRuntime(), {
          source: `return ${output};`,
          host: createHost([]),
        }),
      ).rejects.toMatchObject({ code: "WORKFLOW_SCRIPT_INVALID" });
    }
  });

  test("accepts well-formed Content with a role as input and output", async () => {
    const log: string[] = [];
    const execution = await runWorkflowScript(
      new QuickJSSyncGeneratorRuntime(),
      {
        source: `
          yield ctx.run({
            id: "plan",
            agentName: "planner",
            input: { role: "user", parts: [{ text: "go" }] },
          });
          return { role: "model", parts: [{ text: "done" }] };
        `,
        host: createHost(log),
      },
    );

    expect(execution.output).toEqual({
      role: "model",
      parts: [{ text: "done" }],
    });
    expect(log).toHaveLength(1);
  });

  test("keeps a source that closes the generator body early from running outside it", async () => {
    const log: string[] = [];
    await expect(
      runWorkflowScript(new QuickJSSyncGeneratorRuntime(), {
        source: `
          return "inner";
          };
          return function () {
            return '{"done":true,"value":"escaped"}';
          };
          function* unused() {
        `,
        host: createHost(log),
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_SCRIPT_INVALID" });
    expect(log).toEqual([]);
  });

  // The engine joins the source into the wrapper text, so a source that
  // starts with "})," closes the wrapper and the rest becomes an expression
  // whose value replaces the generator factory.
  const escapes = {
    plainFactory: `}), (function (o) { return o.f })({ f: function () { return { next() { return { done: true, value: "forged" } } } }`,
    proxyFactory: `}), (function (o) { return o.f })({ f: new Proxy(function () {}, { getPrototypeOf: () => Object.getPrototypeOf(function* () {}), apply: () => ({ next() { return { done: true, value: "forged" } } }) })`,
  };

  for (const [name, source] of Object.entries(escapes)) {
    test(`rejects an escaping source that forges the generator (${name})`, async () => {
      const log: string[] = [];
      await expect(
        runWorkflowScript(new QuickJSSyncGeneratorRuntime(), {
          source,
          host: createHost(log),
        }),
      ).rejects.toMatchObject({ code: "WORKFLOW_SCRIPT_INVALID" });
      expect(log).toEqual([]);
    });
  }

  test("drives the generator with the next function captured before guest code", async () => {
    const log: string[] = [];
    const result = await runWorkflowScript(new QuickJSSyncGeneratorRuntime(), {
      source: `}), (Object.getPrototypeOf(Object.getPrototypeOf((function* () {})())).next = function () { return { done: true, value: "forged" } }), (function* () {`,
      host: createHost(log),
    }).then(
      (value) => ({ output: value.output }),
      (error: { code?: unknown }) => ({ code: error.code }),
    );
    // The real generator from the source runs; the patched next is ignored.
    expect(result).toEqual({ output: undefined });
    expect(log).toEqual([]);
  });

  test("an escaping source yields at most a real generator's own output", async () => {
    const log: string[] = [];
    const result = await runWorkflowScript(new QuickJSSyncGeneratorRuntime(), {
      source: `}), globalThis.__escaped = 1, (function* () { return "real generator" }), (function* () {`,
      host: createHost(log),
    }).then(
      (value) => ({ output: value.output }),
      (error: { code?: unknown }) => ({ code: error.code }),
    );
    // The construction-time expression cannot be prevented while the engine
    // joins the source text. Its value must still be a real generator
    // function, and only that generator's own output comes back.
    expect<unknown[]>([
      { code: "WORKFLOW_SCRIPT_INVALID" },
      { output: undefined },
    ]).toContainEqual(result);
    expect(log).toEqual([]);
  });

  test("still reports a syntax error in the source as an invalid script", async () => {
    await expect(
      runWorkflowScript(new QuickJSSyncGeneratorRuntime(), {
        source: "yield ctx.run({ id: ",
        host: createHost([]),
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_SCRIPT_INVALID" });
  });

  test("rejects a malformed generator turn as an invalid script", async () => {
    const turns: unknown[] = [
      null,
      5,
      "turn",
      [],
      {},
      { done: "yes" },
      { done: false, value: {}, extra: true },
    ];
    for (const turn of turns) {
      const runtime: WorkflowScriptRuntime = {
        capabilities: new QuickJSSyncGeneratorRuntime().capabilities,
        createSession: async () => ({
          disposed: false,
          next: () => turn as WorkflowScriptGeneratorTurn,
          dispose: () => undefined,
        }),
      };
      await expect(
        runWorkflowScript(runtime, { source: "", host: createHost([]) }),
      ).rejects.toMatchObject({ code: "WORKFLOW_SCRIPT_INVALID" });
    }
  });

  test("rejects operations, steps and retry policies with unknown or mistyped fields", async () => {
    const operation = (fields: string) =>
      `yield { protocol: ${JSON.stringify(WORKFLOW_SCRIPT_PROTOCOL)}, version: ${WORKFLOW_SCRIPT_PROTOCOL_VERSION}, ${fields} }; return "done";`;
    const step = 'id: "a", agentName: "agent", input: "go"';
    const sources = [
      operation(`op: "run", step: { ${step} }, extra: 1`),
      operation(`op: "parallel", steps: [{ ${step} }], extra: 1`),
      operation(`op: "emit", event: { type: "custom", name: "e" }, extra: 1`),
      operation(`op: "emit", event: { type: "custom", name: "e", extra: 1 }`),
      operation(`op: "parallel", steps: [{ ${step} }], options: { extra: 1 }`),
      `yield ctx.run({ ${step}, unknown: true }); return "done";`,
      `yield ctx.run({ ${step}, retry: { maxAttempts: 2, jitter: 1 } }); return "done";`,
      `yield ctx.run({ ${step}, retry: { maxAttempts: "2" } }); return "done";`,
      `yield ctx.run({ ${step}, retry: 2 }); return "done";`,
      `yield ctx.run({ ${step}, writePaths: [1] }); return "done";`,
      `yield ctx.run({ ${step}, resumePolicy: "always" }); return "done";`,
      `yield ctx.run({ ${step}, metadata: [] }); return "done";`,
    ];
    for (const source of sources) {
      const log: string[] = [];
      await expect(
        runWorkflowScript(new QuickJSSyncGeneratorRuntime(), {
          source,
          host: createHost(log),
        }),
      ).rejects.toMatchObject({ code: "WORKFLOW_SCRIPT_INVALID" });
      expect(log).toEqual([]);
    }
  });

  test("forwards every documented step field", async () => {
    const steps: WorkflowStep[] = [];
    const host = createHost([]);
    host.run = async (step) => {
      steps.push(step);
      return result(step, "ok");
    };
    await runWorkflowScript(new QuickJSSyncGeneratorRuntime(), {
      source: `
        yield ctx.run({
          id: "a",
          agentName: "agent",
          agentRevision: "r1",
          input: "go",
          writePaths: ["src/a.ts"],
          retry: { maxAttempts: 2, delayMs: 1, backoffMultiplier: 2, maxDelayMs: 4 },
          resumePolicy: "retry",
          metadata: { team: "core" },
        });
        return "done";
      `,
      host,
    });
    expect(steps).toEqual([
      {
        id: "a",
        agentName: "agent",
        agentRevision: "r1",
        input: "go",
        writePaths: ["src/a.ts"],
        retry: {
          maxAttempts: 2,
          delayMs: 1,
          backoffMultiplier: 2,
          maxDelayMs: 4,
        },
        resumePolicy: "retry",
        metadata: { team: "core" },
      },
    ]);
  });
});
