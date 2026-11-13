/**
 * A real `LlmAgent` turn with two parallel tool calls, one of which asks for
 * confirmation, through the gateway. Since ADK 2.5 the agent emits the
 * settled tool responses before the confirmation request; the paused step
 * must keep them, so the resumed run neither loses nor repeats the other call.
 */
import { describe, expect, test } from "bun:test";
import {
  type Event,
  FunctionTool,
  LlmAgent,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
} from "@google/adk";
import { AgentInvocationGateway } from "../../src/runtime/agent-invocation-gateway.js";
import {
  parentContext,
  ScriptedLlm,
} from "./gateway-characterization/scenarios.js";

const responsesOf = (event: Event) =>
  (event.content?.parts ?? []).flatMap((part) =>
    part.functionResponse ? [part.functionResponse] : [],
  );

function setup() {
  const ran = { lookup: 0, delete: 0 };
  const lookup = new FunctionTool({
    name: "lookup",
    description: "Looks something up.",
    execute: () => {
      ran.lookup++;
      return { found: "value" };
    },
  });
  const remove = new FunctionTool({
    name: "delete",
    description: "Deletes something.",
    requireConfirmation: true,
    execute: () => {
      ran.delete++;
      return { deleted: true };
    },
  });
  const llm = new ScriptedLlm([
    {
      content: {
        role: "model",
        parts: [
          { functionCall: { id: "call-lookup", name: "lookup", args: {} } },
          { functionCall: { id: "call-delete", name: "delete", args: {} } },
        ],
      },
    },
    { content: { role: "model", parts: [{ text: "all done" }] } },
  ]);
  const worker = new LlmAgent({
    name: "worker",
    model: llm,
    tools: [lookup, remove],
  });
  const gateway = new AgentInvocationGateway({ resolveAgent: () => worker });
  return { ran, llm, worker, gateway };
}

describe("parallel tool calls with a confirmation (real LlmAgent)", () => {
  test("the paused step keeps the settled response before the confirmation request", async () => {
    const { ran, worker, gateway } = setup();

    const result = await gateway.run({
      agentName: "worker",
      input: { role: "user", parts: [{ text: "go" }] },
      parentContext: parentContext(worker),
    });

    expect(ran).toEqual({ lookup: 1, delete: 0 });
    expect(result.interrupt?.kind).toBe("confirmation");
    expect(result.interrupt?.functionCallIds).toHaveLength(1);
    const stored = result.interrupt?.events ?? [];
    const settledAt = stored.findIndex((event) =>
      responsesOf(event).some(
        (response) =>
          response.id === "call-lookup" &&
          (response.response as { found?: string }).found === "value",
      ),
    );
    const requestAt = stored.findIndex((event) =>
      (event.content?.parts ?? []).some(
        (part) =>
          part.functionCall?.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
      ),
    );
    expect(settledAt).toBeGreaterThan(-1);
    expect(requestAt).toBeGreaterThan(settledAt);
  });

  test("a confirmed resume runs the confirmed call once and never repeats the settled one", async () => {
    const { ran, llm, worker, gateway } = setup();
    const context = parentContext(worker);
    const paused = await gateway.run({
      agentName: "worker",
      input: { role: "user", parts: [{ text: "go" }] },
      parentContext: context,
    });
    const requestId = paused.interrupt?.functionCallIds[0] as string;

    const resumed = await gateway.run({
      agentName: "worker",
      input: {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: requestId,
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              response: { confirmed: true },
            },
          },
        ],
      },
      parentContext: context,
      resume: { events: paused.interrupt?.events ?? [] },
    });

    expect(resumed.interrupt).toBeUndefined();
    expect(ran).toEqual({ lookup: 1, delete: 1 });
    expect(llm.calls).toBe(2);
    expect(resumed.output).toBe("all done");
  });
});
