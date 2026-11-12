import { describe, expect, test } from "bun:test";
import {
  CLAUDE_AGENT_DEFINITION,
  ClaudeAgent,
  CODEX_AGENT_DEFINITION,
  CODEX_PROVIDER,
  CodexAgent,
  createDefaultExternalAgentDefinitionRegistry,
  EnvCredentialProvider,
} from "../../src/agents/index.js";

describe("provider agents default to environment credentials", () => {
  test("every built-in definition creates an EnvCredentialProvider", () => {
    for (const definition of [
      CLAUDE_AGENT_DEFINITION,
      CODEX_AGENT_DEFINITION,
    ]) {
      expect(definition.createCredentialProvider?.()).toBeInstanceOf(
        EnvCredentialProvider,
      );
    }
  });

  test("CodexAgent and ClaudeAgent use EnvCredentialProvider", () => {
    expect(new CodexAgent({ name: "a" }).credentialProvider).toBeInstanceOf(
      EnvCredentialProvider,
    );
    expect(new ClaudeAgent({ name: "b" }).credentialProvider).toBeInstanceOf(
      EnvCredentialProvider,
    );
  });

  test("the registry's Codex agent uses EnvCredentialProvider", () => {
    const agent = createDefaultExternalAgentDefinitionRegistry().create(
      "codex",
      { name: "codex" },
    );
    expect(agent.credentialProvider).toBeInstanceOf(EnvCredentialProvider);
  });

  test("the Codex default reads only allowlisted variables", async () => {
    const provider = new EnvCredentialProvider({
      CODEX_API_KEY: "codex-test-value",
      OPENAI_API_KEY: "not-allowlisted",
    });
    const credential = await provider.getCredential({
      providerId: CODEX_PROVIDER.id,
      envAllowlist: CODEX_PROVIDER.envAllowlist,
    });
    expect(credential).toEqual({
      kind: "env",
      label: "codex:env",
      env: { CODEX_API_KEY: "codex-test-value" },
    });
  });

  test("an explicit credentialProvider still wins", () => {
    const custom = { getCredential: async () => undefined };
    expect(
      new CodexAgent({ name: "a", credentialProvider: custom })
        .credentialProvider,
    ).toBe(custom);
  });
});

describe("each built-in driver reports its own capabilities", () => {
  test("CLI drivers claim permission mapping", async () => {
    const { ClaudeCliDriver, CodexCliDriver } = await import(
      "../../src/agents/index.js"
    );
    expect(new ClaudeCliDriver().capabilities()).toEqual({
      streaming: false,
      permissions: true,
    });
    expect(new CodexCliDriver().capabilities()).toEqual({
      streaming: false,
      permissions: true,
    });
  });

  test("an agent built from a definition exposes its driver's capabilities", () => {
    const agent = new CodexAgent({ name: "codex" });
    expect(agent.driver.capabilities?.()).toEqual({
      streaming: true,
      sessions: true,
      permissions: true,
    });
  });
});
