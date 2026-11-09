import { describe, expect, test } from "bun:test";
import { FunctionTool, InMemoryRunner } from "@google/adk";
import { z } from "zod";
import {
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentEvent,
  type ExternalAgentRunRequest,
} from "../../src/agents/index.js";
import type {
  PermissionDecision,
  PermissionRequest,
} from "../../src/agents/permissions/confirmation.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/schema.js";

/** Asks for permission for each tool name and records the decisions. */
class AskingDriver implements ExternalAgentDriver {
  readonly providerId = CODEX_PROVIDER.id;
  readonly decisions = new Map<string, PermissionDecision>();

  constructor(private readonly toolNames: readonly string[]) {}

  async *run(
    request: ExternalAgentRunRequest,
  ): AsyncIterable<ExternalAgentEvent> {
    for (const toolName of this.toolNames) {
      const call: PermissionRequest = {
        requestId: toolName,
        toolName,
        input: {},
      };
      const decision = await request.requestPermission?.(call);
      if (decision) this.decisions.set(toolName, decision);
    }
    yield { type: "output", content: "done" };
  }
}

async function run(agent: ExternalAgent): Promise<void> {
  const runner = new InMemoryRunner({ agent, appName: "app" });
  const session = await runner.sessionService.createSession({
    appName: "app",
    userId: "user",
  });
  for await (const _ of runner.runAsync({
    userId: "user",
    sessionId: session.id,
    newMessage: { role: "user", parts: [{ text: "go" }] },
  })) {
    // drain
  }
}

describe("ExternalAgent exempts only its registered bridge tools from the MCP network denial", () => {
  test("a host server whose name starts with the bridge's is denied", async () => {
    const registered = "mcp__adk_bridge__adk_tool__lookup";
    const impostor = "mcp__adk_bridge__x__exfiltrate";
    const driver = new AskingDriver([registered, impostor]);
    const agent = new ExternalAgent({
      name: "worker",
      provider: CODEX_PROVIDER,
      driver,
      permissions: { mode: "ask" },
      tools: [
        new FunctionTool({
          name: "lookup",
          description: "lookup",
          parameters: z.object({}),
          execute: async () => ({ ok: true }),
        }),
      ],
      confirmation: { approver: () => true },
    });
    await run(agent);
    expect(driver.decisions.get(registered)).toMatchObject({
      behavior: "allow",
    });
    expect(driver.decisions.get(impostor)).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("may reach the network"),
    });
  });
});
