/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  createEvent,
  InMemorySessionService,
  type InvocationContext,
  Runner,
} from "@google/adk";
import { WORKFLOW_CHECKPOINT_STATE_PREFIX } from "../../src/workflows/checkpoint/store.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

class ReplyAgent extends BaseAgent {
  constructor(name: string) {
    super({ name });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: "reply" }] },
    });
  }

  protected async *runLiveImpl() {}
}

function delegating(name: string, child: BaseAgent) {
  return new WorkflowAgent({
    name,
    subAgents: [child],
    definition: defineWorkflow({
      id: name,
      version: "1",
      handler: async (ctx) => {
        const result = await ctx.run({
          id: "delegate",
          agentName: child.name,
          input: ctx.inputText,
        });
        return `${name}(${result.output})`;
      },
    }),
  });
}

describe("nested WorkflowAgent", () => {
  test("a WorkflowAgent can be a step of another on the default store", async () => {
    const inner = delegating("inner", new ReplyAgent("worker"));
    const outer = delegating("outer", inner);
    const sessions = new InMemorySessionService();
    const runner = new Runner({
      appName: "nested",
      agent: outer,
      sessionService: sessions,
    });
    const session = await sessions.createSession({
      appName: "nested",
      userId: "user",
    });

    const events = [];
    for await (const event of runner.runAsync({
      userId: "user",
      sessionId: session.id,
      newMessage: { role: "user", parts: [{ text: "hi" }] },
    })) {
      events.push(event);
    }

    expect(
      events.some((e) => e.content?.parts?.[0]?.text === "outer(inner(reply))"),
    ).toBe(true);
    const state =
      (
        await sessions.getSession({
          appName: "nested",
          userId: "user",
          sessionId: session.id,
        })
      )?.state ?? {};
    const keys = Object.keys(state).filter((key) =>
      key.startsWith(`${WORKFLOW_CHECKPOINT_STATE_PREFIX}:`),
    );
    expect(keys.some((key) => key.includes(":inner:"))).toBe(true);
    expect(keys.some((key) => key.includes(":outer:"))).toBe(true);
    // The outer checkpoint does not embed the inner one.
    const outerCheckpoint = JSON.stringify(
      state[keys.find((key) => key.includes(":outer:")) as string],
    );
    expect(outerCheckpoint).not.toContain(WORKFLOW_CHECKPOINT_STATE_PREFIX);
  });
});
