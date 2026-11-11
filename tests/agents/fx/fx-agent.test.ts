import { describe, expect, test } from "bun:test";
import { FunctionTool, LlmAgent } from "@google/adk";
import { z } from "zod";
import { FxCliDriver } from "../../../src/agents/driver/fx-cli.js";
import {
  createDefaultExternalAgentDefinitionRegistry,
  createDefaultExternalAgentProviderRegistry,
  ExternalAgent,
  FX_AGENT_DEFINITION,
  FX_ENV_ALLOWLIST,
  FX_PROVIDER,
  FxAgent,
} from "../../../src/agents/index.js";
import { baseConfig, FX_MODEL_ID } from "./helpers.js";

const weather = new FunctionTool({
  name: "get_weather",
  description: "Weather.",
  parameters: z.object({}),
  execute: () => ({}),
});

function codeOf(fn: () => unknown): { code?: string; message: string } {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error("did not throw");
}

const driverOptions = {
  model: FX_MODEL_ID,
  inheritHostConfig: true,
} as const;

describe("FxAgent", () => {
  test("wires the fx provider and the fx CLI driver without side effects", () => {
    const agent = new FxAgent({ name: "fx", driverOptions });
    expect(agent).toBeInstanceOf(ExternalAgent);
    expect(agent.provider).toBe(FX_PROVIDER);
    expect(agent.driver).toBeInstanceOf(FxCliDriver);
  });

  test("the definition is a CLI runtime for the fx provider", () => {
    expect(FX_AGENT_DEFINITION.provider).toBe(FX_PROVIDER);
    expect(FX_AGENT_DEFINITION.runtime).toBe("cli");
    expect(FX_PROVIDER.id).toBe("fx");
    expect(FX_ENV_ALLOWLIST).toContain("AI_GATEWAY_API_KEY");
  });

  test("the default definition registry holds fx", () => {
    expect(createDefaultExternalAgentDefinitionRegistry().get("fx")).toEqual(
      FX_AGENT_DEFINITION,
    );
  });

  test("the default provider registry holds fx", () => {
    expect(createDefaultExternalAgentProviderRegistry().get("fx")).toEqual(
      FX_PROVIDER,
    );
  });

  test("capabilities are streaming off, permissions on", () => {
    const agent = new FxAgent({ name: "fx", driverOptions });
    expect(agent.driver.capabilities?.()).toEqual({
      streaming: false,
      permissions: true,
    });
  });

  test("the agent requires an explicit model by default", () => {
    expect(
      codeOf(
        () =>
          new FxAgent({
            name: "fx",
            driverOptions: { inheritHostConfig: true },
          }),
      ).code,
    ).toBe("EXTERNAL_AGENT_MODEL_REQUIRED");
    expect(
      new FxAgent({ name: "fx", driverOptions }).driver.requireExplicitModel,
    ).toBe(true);
  });

  test("ADK tools are refused, naming the driver", () => {
    const error = codeOf(
      () => new FxAgent({ name: "fx", driverOptions, tools: [weather] }),
    );
    expect(error.code).toBe("EXTERNAL_AGENT_TOOLS_UNSUPPORTED");
    expect(error.message).toContain("FxCliDriver");
    expect(error.message).toContain("ClaudeAgent");
  });

  test("an approver and ADK confirmation are refused, naming the driver", () => {
    for (const confirmation of [{ approver: () => true }, { adk: true }]) {
      const error = codeOf(
        () => new FxAgent({ name: "fx", driverOptions, confirmation }),
      );
      expect(error.code).toBe("EXTERNAL_AGENT_APPROVALS_UNSUPPORTED");
      expect(error.message).toContain("FxCliDriver");
    }
  });

  test("no approver and no confirmation is fine", () => {
    expect(
      () => new FxAgent({ name: "fx", driverOptions, confirmation: {} }),
    ).not.toThrow();
  });

  test("the same refusals apply to a plain ExternalAgent around the driver", () => {
    const driver = new FxCliDriver(baseConfig());
    expect(
      codeOf(
        () =>
          new ExternalAgent({
            name: "x",
            provider: FX_PROVIDER,
            driver,
            tools: [weather],
          }),
      ).code,
    ).toBe("EXTERNAL_AGENT_TOOLS_UNSUPPORTED");
  });

  test("sub-agents are refused, naming the driver", () => {
    const sub = new LlmAgent({ name: "helper", model: "gemini-2.5-flash" });
    const error = codeOf(
      () => new FxAgent({ name: "fx", driverOptions, subAgents: [sub] }),
    );
    expect(error.code).toBe("EXTERNAL_AGENT_SUBAGENTS_UNSUPPORTED");
    expect(error.message).toContain("FxCliDriver");
  });

  test("an empty subAgents list is fine", () => {
    expect(
      () => new FxAgent({ name: "fx", driverOptions, subAgents: [] }),
    ).not.toThrow();
  });
});
