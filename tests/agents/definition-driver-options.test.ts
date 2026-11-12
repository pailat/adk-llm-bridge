import { describe, expect, test } from "bun:test";
import { InputValidationError } from "@google/adk";
import {
  CLAUDE_AGENT_DEFINITION,
  ClaudeAgentSdkDriver,
  CODEX_AGENT_DEFINITION,
  CODEX_PROVIDER,
  CodexSdkDriver,
  createDefaultExternalAgentDefinitionRegistry,
  createExternalAgent,
  createExternalAgentConfig,
  type ExternalAgentDefinition,
  FX_AGENT_DEFINITION,
  FxCliDriver,
  PlaceholderExternalAgentDriver,
} from "../../src/agents/index.js";

describe("definitions build their driver from driverOptions", () => {
  test("createDriver takes the driver options", () => {
    const claude = CLAUDE_AGENT_DEFINITION.createDriver?.({
      model: "claude-haiku-4-5",
    });
    expect(claude).toBeInstanceOf(ClaudeAgentSdkDriver);
    expect(claude?.model).toBe("claude-haiku-4-5");
    expect(CODEX_AGENT_DEFINITION.createDriver?.()).toBeInstanceOf(
      CodexSdkDriver,
    );
    expect(FX_AGENT_DEFINITION.createDriver?.({ model: "anthropic/claude-haiku-4-5" })).toBeInstanceOf(FxCliDriver);
  });

  test("registry.create() applies driverOptions", () => {
    const agent = createDefaultExternalAgentDefinitionRegistry().create(
      "codex",
      { name: "codex", driverOptions: { model: "gpt-5-codex" } },
    );
    expect(agent.driver).toBeInstanceOf(CodexSdkDriver);
    expect(agent.driver.model).toBe("gpt-5-codex");
  });

  test("createExternalAgent() applies driverOptions", () => {
    const agent = createExternalAgent(CLAUDE_AGENT_DEFINITION, {
      name: "claude",
      driverOptions: { model: "claude-haiku-4-5" },
    });
    expect(agent.driver).toBeInstanceOf(ClaudeAgentSdkDriver);
    expect(agent.driver.model).toBe("claude-haiku-4-5");
  });

  test("createExternalAgentConfig() drops driverOptions from the result", () => {
    const config = createExternalAgentConfig(CODEX_AGENT_DEFINITION, {
      name: "codex",
      driverOptions: { model: "gpt-5-codex" },
    });
    expect(config).not.toHaveProperty("driverOptions");
    expect(config.driver?.model).toBe("gpt-5-codex");
  });

  test("driver and driverOptions together are rejected on every path", () => {
    const driver = new PlaceholderExternalAgentDriver("codex");
    const both = { name: "codex", driver, driverOptions: { model: "m" } };
    expect(() =>
      createDefaultExternalAgentDefinitionRegistry().create("codex", both),
    ).toThrow(InputValidationError);
    expect(() => createExternalAgent(CODEX_AGENT_DEFINITION, both)).toThrow(
      InputValidationError,
    );
  });

  test("driverOptions for a definition without a default driver are rejected", () => {
    const definition: ExternalAgentDefinition = { provider: CODEX_PROVIDER };
    expect(() =>
      createExternalAgent(definition, {
        name: "codex",
        driverOptions: { model: "m" },
      }),
    ).toThrow(InputValidationError);
  });

  test("driverOptions: null from untyped code counts as no options", () => {
    const options = { name: "codex", driverOptions: null } as unknown as {
      name: string;
    };
    const agent = createExternalAgent(CODEX_AGENT_DEFINITION, options);
    expect(agent.driver).toBeInstanceOf(CodexSdkDriver);
    const config = createExternalAgentConfig(CODEX_AGENT_DEFINITION, options);
    expect(config).not.toHaveProperty("driverOptions");
  });
});
