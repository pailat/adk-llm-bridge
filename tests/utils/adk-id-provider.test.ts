/**
 * ADK 2.5's `setIdProvider` controls the ids ADK generates. The ids the
 * bridge mints for ADK events (function-call, confirmation-request and
 * invocation ids) come from the same provider, so an application that sets
 * one gets it everywhere.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  FunctionTool,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  resetIdProvider,
  setIdProvider,
} from "@google/adk";
import { createConfirmationRequestEvent } from "../../src/agents/permissions/confirmation.js";
import { createAdkToolBridge } from "../../src/agents/tools/adk-tool-bridge.js";
import {
  generateToolCallId,
  isPortableToolCallId,
} from "../../src/converters/tool-call-ids.js";

function useIds(values: string[]): void {
  let next = 0;
  setIdProvider(() => values[next++] ?? `extra-${next}`);
}

async function invocation(): Promise<InvocationContext> {
  const sessions = new InMemorySessionService();
  const session = await sessions.createSession({ appName: "app", userId: "u" });
  return new InvocationContext({
    invocationId: "inv-1",
    agent: new LlmAgent({ name: "agent" }),
    session,
    sessionService: sessions,
    pluginManager: new PluginManager(),
  });
}

afterEach(() => resetIdProvider());

describe("generateToolCallId", () => {
  it("uses the ADK id provider", () => {
    useIds(["fixed-1"]);
    expect(generateToolCallId()).toBe("call_fixed-1");
  });

  it("keeps a random portable id when the provider's id is not portable", () => {
    useIds(["has space", "x".repeat(64)]);
    for (let i = 0; i < 2; i++) {
      const id = generateToolCallId();
      expect(isPortableToolCallId(id)).toBe(true);
      expect(id).toMatch(/^call_[0-9a-f]{32}$/);
    }
  });

  it("keeps its format without a provider", () => {
    expect(generateToolCallId()).toMatch(/^call_[0-9a-f]{32}$/);
  });
});

describe("ids the bridge puts on ADK events", () => {
  it("the confirmation request call id comes from the provider", async () => {
    const context = await invocation();
    useIds(["request-1", "event-1"]);
    const event = createConfirmationRequestEvent({
      context,
      agentName: "agent",
      request: { requestId: "r", toolName: "Bash", input: {} },
    });
    const call = event.content?.parts?.[0]?.functionCall;
    expect(call?.name).toBe(REQUEST_CONFIRMATION_FUNCTION_CALL_NAME);
    expect(call?.id).toBe("adk-request-1");
    expect(event.longRunningToolIds).toEqual(["adk-request-1"]);
  });

  it("a bridged ADK tool call without an id gets one from the provider", async () => {
    const tool = new FunctionTool({
      name: "gated",
      description: "needs a human",
      requireConfirmation: true,
      execute: () => ({ ok: true }),
    });
    const context = await invocation();
    const bridge = await createAdkToolBridge([tool], context);
    useIds(["call-1"]);
    const result = await bridge.execute("adk_tool__gated", {}, context);
    expect(result.status).toBe("confirmationRequired");
    expect(result.confirmation?.functionCallId).toBe("adk-bridge-call-1");
  });
});
