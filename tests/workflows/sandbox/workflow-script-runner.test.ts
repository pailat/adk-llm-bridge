/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import type {
  WorkflowStep,
  WorkflowStepOutcome,
  WorkflowStepResult,
} from "../../../src/workflows/contracts.js";
import type { WorkflowUserEvent } from "../../../src/workflows/events.js";
import type { WorkflowScriptHost } from "../../../src/workflows/sandbox/protocol.js";
import { QuickJSSyncGeneratorRuntime } from "../../../src/workflows/sandbox/quickjs-generator-runtime.js";
import { runWorkflowScript } from "../../../src/workflows/sandbox/workflow-script-runner.js";

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
    const events = [
      { author: "agent", content: { parts: [{ text: "internal" }] } },
    ] as WorkflowStepResult["events"];
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
          events: [{ author: "left" }] as WorkflowStepResult["events"],
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
    const history = Array.from({ length: 32 }, (_, index) => ({
      author: `agent-${index}`,
      content: { parts: [{ text: "x".repeat(128) }] },
    })) as WorkflowStepResult["events"];
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
    host.run = async () => await new Promise<WorkflowStepResult>(() => {});
    const execution = runWorkflowScript(runtime, {
      source: `yield ctx.run({ id: "wait", agentName: "agent", input: "wait" });`,
      signal: controller.signal,
      host,
    });
    setTimeout(() => controller.abort(), 5);
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
});
