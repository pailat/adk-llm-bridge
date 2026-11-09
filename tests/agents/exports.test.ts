import { describe, expect, test } from "bun:test";
import { BaseAgent } from "@google/adk";
import packageJson from "../../package.json" with { type: "json" };
import * as agents from "../../src/agents/index.js";
import * as root from "../../src/index.js";

describe("agents public exports", () => {
  test("root export behavior remains LLM-focused", () => {
    expect(root.AIGateway).toBeFunction();
    expect(root.OpenRouter).toBeFunction();
    expect(root.OpenAI).toBeFunction();
    expect(root.Anthropic).toBeFunction();
    expect(root.XAI).toBeFunction();
    expect(root.Custom).toBeFunction();
    expect("CodexAgent" in root).toBe(false);
    expect("ClaudeAgent" in root).toBe(false);
    expect("GeminiCliAgent" in root).toBe(false);
    expect("ExternalAgent" in root).toBe(false);
    expect("EnvCredentialProvider" in root).toBe(false);
  });

  test("./agents exposes the default Claude SDK tool list", () => {
    expect(Array.isArray(agents.DEFAULT_CLAUDE_SDK_TOOLS)).toBe(true);
    expect(agents.DEFAULT_CLAUDE_SDK_TOOLS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(agents.DEFAULT_CLAUDE_SDK_TOOLS)).toBe(true);
  });

  test("./agents exposes the driver policy errors and their codes", () => {
    expect(agents.EXTERNAL_AGENT_ISOLATION_VIOLATED).toBe(
      "EXTERNAL_AGENT_ISOLATION_VIOLATED",
    );
    expect(agents.EXTERNAL_AGENT_NETWORK_UNENFORCEABLE).toBe(
      "EXTERNAL_AGENT_NETWORK_UNENFORCEABLE",
    );
    expect(agents.EXTERNAL_AGENT_DEPENDENCY_MISSING).toBe(
      "EXTERNAL_AGENT_DEPENDENCY_MISSING",
    );
    // The code the error classifier already gives a missing CLI binary.
    expect(agents.EXTERNAL_AGENT_MISSING_BINARY).toBe("MISSING_BINARY");
    const error = new agents.ExternalAgentPolicyError(
      agents.EXTERNAL_AGENT_NETWORK_UNENFORCEABLE,
      "no sandbox",
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("EXTERNAL_AGENT_NETWORK_UNENFORCEABLE");
    expect(error.recoverable).toBe(false);
  });

  test("./agents exposes the external agent error codes", () => {
    expect(agents.EXTERNAL_AGENT_ERROR).toBe("EXTERNAL_AGENT_ERROR");
    expect(agents.EXTERNAL_AGENT_TRANSFER_FAILED).toBe(
      "EXTERNAL_AGENT_TRANSFER_FAILED",
    );
    expect(agents.EXTERNAL_AGENT_NOT_CONFIGURED).toBe(
      "EXTERNAL_AGENT_NOT_CONFIGURED",
    );
  });

  test("./agents exports the types a custom driver's run request uses", async () => {
    // Compile-time check: a driver can name the bridge and gateway types.
    const execute: agents.AdkToolBridge["execute"] = async (
      _name,
      _args,
      _context,
      _options?: agents.AdkToolExecuteOptions,
    ): Promise<agents.AdkToolExecutionResult> => {
      const code: agents.AdkToolErrorCode = "UNKNOWN_TOOL";
      const actions: agents.AdkToolActions = {
        stateDelta: {},
        artifactDelta: {},
        requestedToolConfirmations: {},
      };
      return {
        status: "error",
        response: { error: code },
        actions,
        error: { code, message: code },
      };
    };
    const declaration: agents.PortableToolDeclaration = {
      name: "adk_tool__x",
      description: "x",
      inputSchema: { type: "object" },
    };
    const skipped: agents.SkippedTool[] = [];
    const kind: agents.AgentInvocationErrorKind = "agent-error";
    const failed: Pick<agents.RunSubAgentResult, "errorKind"> = {
      errorKind: kind,
    };
    expect(failed.errorKind).toBe("agent-error");
    const sink: agents.ToolGatewayEventSink = () => {};
    const tracer: agents.ToolGatewayDelegationTracer = (
      _info: agents.ToolGatewayDelegationInfo,
      run,
    ) => run();
    expect(declaration.name).toBe("adk_tool__x");
    expect(skipped).toEqual([]);
    expect(sink).toBeFunction();
    expect(tracer).toBeFunction();
    const result = await execute("x", {}, {} as never);
    expect(result.status).toBe("error");
  });

  test("./agents exports the CodexMcpLister type of the listMcpServers option", async () => {
    const lister: agents.CodexMcpLister = async ({ command }) => [command];
    const driver = new agents.CodexCliDriver({ listMcpServers: lister });
    expect(driver).toBeInstanceOf(agents.CodexCliDriver);
    await expect(lister({ command: "codex", env: {} })).resolves.toEqual([
      "codex",
    ]);
  });

  test("./agents exposes the default Claude tool list shared by both drivers", () => {
    expect(Object.isFrozen(agents.DEFAULT_CLAUDE_TOOLS)).toBe(true);
    expect(agents.DEFAULT_CLAUDE_TOOLS.length).toBeGreaterThan(0);
    expect(agents.DEFAULT_CLAUDE_SDK_TOOLS).toEqual(
      agents.DEFAULT_CLAUDE_TOOLS,
    );
  });

  test("./agents exposes external agent symbols", () => {
    expect(agents.BaseAgent).toBe(BaseAgent);
    expect(agents.ExternalAgent).toBeFunction();
    expect(agents.createExternalAgent).toBeFunction();
    expect(agents.createExternalAgentConfig).toBeFunction();
    expect(agents.ExternalAgentDefinitionRegistry).toBeFunction();
    expect(agents.createDefaultExternalAgentDefinitionRegistry).toBeFunction();
    expect(agents.CodexAgent).toBeFunction();
    expect(agents.ClaudeAgent).toBeFunction();
    expect(agents.GeminiCliAgent).toBeFunction();
    expect(agents.CODEX_AGENT_DEFINITION.provider).toBe(agents.CODEX_PROVIDER);
    expect(agents.CLAUDE_AGENT_DEFINITION.provider).toBe(
      agents.CLAUDE_PROVIDER,
    );
    expect(agents.GEMINI_CLI_AGENT_DEFINITION.provider).toBe(
      agents.GEMINI_CLI_PROVIDER,
    );
    expect(agents.ExternalAgentProviderRegistry).toBeFunction();
    expect(agents.EnvCredentialProvider).toBeFunction();
    expect(agents.NoopCredentialProvider).toBeFunction();
    expect(agents.CodexSdkDriver).toBeFunction();
    expect(agents.PlaceholderExternalAgentDriver).toBeFunction();
    expect(agents.readAllowedEnv).toBeFunction();
    expect(agents.mapPermissionModeToPolicy).toBeFunction();
    expect(agents.deriveSubAgentPermissionPolicy).toBeFunction();
    expect(agents.ToolGateway).toBeFunction();
    expect(agents.claudeSdkSessionStateKey("a")).toBe("claude_sdk_session:a");
  });

  test("./agents does not expose driver internals", () => {
    const internal = [
      // driver building blocks and input converters
      "SubprocessJsonlDriver",
      "contentsToSdkMessages",
      "summarizeHistoryForColdStart",
      "userContentToCodexInput",
      "collectContents",
      "flattenContentsToPrompt",
      // per-runtime permission mappers
      "mapPolicyToClaudeSdkPermission",
      "mapPolicyToCodexArgs",
      "mapPolicyToCodexSdkThreadOptions",
      "mapClaudePermissionArgs",
      "mapGeminiPermissionArgs",
      "buildGeminiArgs",
      "mapPermissionPolicyToFlags",
      // shared mutable singletons
      "externalAgentProviderRegistry",
      "externalAgentDefinitionRegistry",
      // replaced by createExternalAgentConfig's driverOptions
      "applyDriverOptions",
    ];
    for (const name of internal) {
      expect(name in agents).toBe(false);
    }
  });

  test("./agents exposes the error classification codes", () => {
    expect(agents.normalizeRecoverableErrorCode("CODEX_QUOTA_EXHAUSTED")).toBe(
      "QUOTA_EXHAUSTED",
    );
    expect(agents.LEGACY_RECOVERABLE_ERROR_CODES.CLAUDE_RATE_LIMIT).toBe(
      "RATE_LIMIT",
    );
    const code: agents.RecoverableErrorCode = "QUOTA_EXHAUSTED";
    expect(agents.classifyRecoverable({ subtype: code }).code).toBe(code);
    expect(agents.EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED).toBe(
      "EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED",
    );
  });

  test("provider-backed agents preserve expected public shape", () => {
    const codex = new agents.CodexAgent({ name: "codex" });
    const claude = new agents.ClaudeAgent({ name: "claude" });
    const gemini = new agents.GeminiCliAgent({ name: "gemini" });

    expect(codex).toBeInstanceOf(agents.ExternalAgent);
    expect(codex).toBeInstanceOf(BaseAgent);
    expect(codex.provider).toEqual(agents.CODEX_PROVIDER);
    expect(claude.provider).toEqual(agents.CLAUDE_PROVIDER);
    expect(gemini.provider).toEqual(agents.GEMINI_CLI_PROVIDER);

    const root = new agents.ClaudeAgent({
      name: "root",
      subAgents: [codex, gemini],
    });
    expect(root.subAgents).toEqual([codex, gemini]);
  });

  test("package exports preserves root and adds agents subpath", () => {
    expect(packageJson.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    });
    expect(packageJson.exports["./agents"]).toEqual({
      types: "./dist/agents/index.d.ts",
      import: "./dist/agents/index.js",
    });
  });
});
