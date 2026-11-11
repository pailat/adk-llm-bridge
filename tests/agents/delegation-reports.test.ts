/**
 * A delegated child's model and tools reports reach the host stream, on the
 * child's own events (author = the child), and never merge into the
 * coordinator's own report.
 */

import { describe, expect, test } from "bun:test";
import type { Event, InvocationContext } from "@google/adk";
import { FunctionTool } from "@google/adk";
import { z } from "zod";
import {
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentEvent,
  type ExternalAgentModelInfo,
  type ExternalAgentRunRequest,
} from "../../src/agents/index.js";
import { CLAUDE_PROVIDER } from "../../src/agents/provider/schema.js";

const tool = (name: string) =>
  new FunctionTool({
    name,
    description: `Tool ${name}.`,
    parameters: z.object({}),
    execute: () => ({ name }),
  });

/**
 * A child whose run bills a main and a helper model. With `hiddenTool` it
 * also has a tool the read-only coordinator hides, so it reports a tools
 * report; without, it reports its models only.
 */
function writer(hiddenTool = true): ExternalAgent {
  const driver: ExternalAgentDriver = {
    providerId: CLAUDE_PROVIDER.id,
    model: "claude-main",
    reportsResolvedModel: true,
    async *run() {
      yield { type: "started", providerId: CLAUDE_PROVIDER.id };
      yield { type: "output", content: "written" };
      yield {
        type: "completed",
        exitCode: 0,
        usage: {
          byModel: {
            "claude-main": { inputTokens: 1 },
            "claude-helper": { inputTokens: 1 },
          },
        },
      };
    },
  };
  return new ExternalAgent({
    name: "writer",
    provider: CLAUDE_PROVIDER,
    driver,
    permissions: { mode: "workspace-write", allowNetwork: false },
    ...(hiddenTool ? { tools: [tool("delete_all")] } : {}),
  });
}

function coordinator(
  child: ExternalAgent,
  finalAnswer: "subagent" | "coordinator" = "subagent",
): ExternalAgent {
  const driver: ExternalAgentDriver = {
    providerId: CLAUDE_PROVIDER.id,
    model: "claude-coord",
    reportsResolvedModel: true,
    async *run(request: ExternalAgentRunRequest) {
      yield { type: "started", providerId: CLAUDE_PROVIDER.id };
      await request.toolGateway?.runSubAgent({
        agentName: "writer",
        task: "write it",
      });
      yield { type: "output", content: "coordinator done" };
      yield {
        type: "completed",
        exitCode: 0,
        usage: { byModel: { "claude-coord": { inputTokens: 1 } } },
      } as ExternalAgentEvent;
    },
  };
  return new ExternalAgent({
    name: "coordinator",
    provider: CLAUDE_PROVIDER,
    driver,
    permissions: { mode: "read-only", allowNetwork: false },
    subAgents: [child],
    delegation: { finalAnswer },
  });
}

async function collect(agent: ExternalAgent): Promise<Event[]> {
  const events: Event[] = [];
  const context = {
    invocationId: "inv-1",
    agent,
    branch: undefined,
    session: { id: "s1", appName: "a", userId: "u", state: {}, events: [] },
  } as unknown as InvocationContext;
  for await (const event of agent.runAsync(context)) events.push(event);
  return events;
}

const modelOf = (event: Event) =>
  event.customMetadata?.externalAgentModel as
    | ExternalAgentModelInfo
    | undefined;
const toolsOf = (event: Event) => event.customMetadata?.externalAgentTools;

describe("delegation keeps each child's reports", () => {
  test("the child's final event carries its model and tools reports", async () => {
    const events = await collect(coordinator(writer()));
    const own = events.filter((event) => event.author === "writer");
    const withModel = own.filter((event) => modelOf(event) !== undefined);
    expect(withModel).toHaveLength(1);
    expect(modelOf(withModel[0] as Event)).toMatchObject({
      requested: "claude-main",
      used: ["claude-helper", "claude-main"],
      unexpected: ["claude-helper"],
    });
    const withTools = own.filter((event) => toolsOf(event) !== undefined);
    expect(withTools).toHaveLength(1);
    expect(toolsOf(withTools[0] as Event)).toEqual({
      hidden: ["delete_all"],
      reason: "read-only",
    });
  });

  test("a child with no hidden tool still carries its model report", async () => {
    // externalAgentTools exists only when a tool is hidden: the common child
    // has a model report alone, and it must not be dropped with it.
    const events = await collect(coordinator(writer(false)));
    const own = events.filter((event) => event.author === "writer");
    const withModel = own.filter((event) => modelOf(event) !== undefined);
    expect(withModel).toHaveLength(1);
    expect(modelOf(withModel[0] as Event)).toMatchObject({
      used: ["claude-helper", "claude-main"],
      unexpected: ["claude-helper"],
    });
    for (const event of own) {
      expect(event.customMetadata).not.toHaveProperty("externalAgentTools");
    }
  });

  test("the coordinator's own report stays its own", async () => {
    // With the coordinator owning the final answer, its final event is kept.
    const events = await collect(coordinator(writer(), "coordinator"));
    const mine = events.filter(
      (event) => event.author === "coordinator" && modelOf(event) !== undefined,
    );
    expect(mine).toHaveLength(1);
    expect(modelOf(mine[0] as Event)).toMatchObject({
      requested: "claude-coord",
      used: ["claude-coord"],
      unexpected: [],
    });
    expect(toolsOf(mine[0] as Event)).toBeUndefined();
  });

  test("nothing else of the child's metadata leaks onto the timeline", async () => {
    const events = await collect(coordinator(writer()));
    for (const event of events.filter((e) => e.author === "writer")) {
      const keys = Object.keys(event.customMetadata ?? {}).filter(
        (key) => key !== "externalAgentModel" && key !== "externalAgentTools",
      );
      expect(keys).toEqual([]);
    }
  });
});
