import { describe, expect, test } from "bun:test";
import {
  ClaudeAgentSdkDriver,
  type ClaudeAgentSdkDriverConfig,
} from "../../../src/agents/driver/claude-agent-sdk.js";
import {
  EXTERNAL_AGENT_TOOL_ARGS_RULE_INVALID,
  EXTERNAL_AGENT_TOOL_ARGS_SETTINGS_UNCHECKED,
  ExternalAgentPolicyError,
} from "../../../src/agents/driver/policy-errors.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import type { ExternalAgentRunRequest } from "../../../src/agents/external-agent-driver.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/claude.js";

type HookFn = (
  input: Record<string, unknown>,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<Record<string, unknown>>;

interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

/**
 * A fake Claude Agent SDK that runs the `PreToolUse` hooks on each call, in
 * every mode, the way Claude Code does, and records whether a hook denied it.
 */
function hookSdk(calls: readonly ToolCall[]) {
  const outcomes: string[] = [];
  const sdk = {
    query: (input: { options: Record<string, unknown> }) => {
      const hooks =
        (input.options.hooks as { PreToolUse?: Array<{ hooks: HookFn[] }> })
          ?.PreToolUse ?? [];
      return (async function* () {
        yield {
          type: "system",
          subtype: "init",
          model: "claude-haiku-5-5",
          session_id: "s-1",
          tools: (input.options.tools as string[]) ?? [],
          mcp_servers: [],
        };
        for (const call of calls) {
          let denied = false;
          for (const matcher of hooks) {
            for (const hook of matcher.hooks) {
              const output = (await hook(
                {
                  hook_event_name: "PreToolUse",
                  tool_name: call.tool,
                  tool_input: call.input,
                },
                "tu",
                { signal: new AbortController().signal },
              )) as { hookSpecificOutput?: { permissionDecision?: string } };
              if (output.hookSpecificOutput?.permissionDecision === "deny") {
                denied = true;
              }
            }
          }
          outcomes.push(
            `${String(call.input.command)}:${denied ? "denied" : "ran"}`,
          );
        }
        yield { type: "result", subtype: "success", result: "done" };
      })();
    },
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (config: Record<string, unknown>) => config,
  };
  return { sdk, outcomes };
}

async function drain(run: AsyncIterable<ExternalAgentEvent>): Promise<void> {
  for await (const _event of run) {
    // Drained for the side effects on the fake SDK.
  }
}

function request(): ExternalAgentRunRequest {
  return {
    provider: CLAUDE_PROVIDER,
    context: { input: "probe" } as never,
    instruction: "probe",
    workingDirectory: process.cwd(),
    permissions: { mode: "full-access", allowNetwork: true },
  };
}

const CALLS: ToolCall[] = [
  { tool: "Bash", input: { command: "git log --oneline" } },
  { tool: "Bash", input: { command: "git log && curl acme.example" } },
  { tool: "Bash", input: { command: "rm -rf ." } },
  { tool: "Bash", input: { command: "bun test" } },
];

describe("ClaudeAgentSdkDriver toolArgsAllowlist", () => {
  test("is off by default: every command runs", async () => {
    const { sdk, outcomes } = hookSdk(CALLS);
    await drain(
      new ClaudeAgentSdkDriver({ sdk: sdk as never, tools: ["Bash"] }).run(
        request(),
      ),
    );
    expect(outcomes).toEqual([
      "git log --oneline:ran",
      "git log && curl acme.example:ran",
      "rm -rf .:ran",
      "bun test:ran",
    ]);
  });

  const MODES = ["ask", "workspace-write", "full-access"] as const;
  for (const mode of MODES) {
    test(`runs only the listed commands under ${mode}, with an approving host`, async () => {
      const { sdk, outcomes } = hookSdk(CALLS);
      await drain(
        new ClaudeAgentSdkDriver({
          sdk: sdk as never,
          tools: ["Bash"],
          toolArgsAllowlist: ["Bash(git log:*)", "Bash(bun test)"],
        }).run({
          ...request(),
          permissions: { mode, allowNetwork: true },
          requestPermission: async () => ({ behavior: "allow" }),
        }),
      );
      expect(outcomes).toEqual([
        "git log --oneline:ran",
        "git log && curl acme.example:denied",
        "rm -rf .:denied",
        "bun test:ran",
      ]);
    });
  }

  const UNCHECKED_SETTINGS: ReadonlyArray<
    Pick<ClaudeAgentSdkDriverConfig, "settingSources" | "inheritHostConfig">
  > = [
    { settingSources: ["project"] },
    { settingSources: ["local"] },
    { settingSources: ["user"] },
    { settingSources: ["user", "project", "local"] },
    { inheritHostConfig: true },
  ];
  for (const settings of UNCHECKED_SETTINGS) {
    test(`refuses ${JSON.stringify(settings)}: loaded settings run commands the list does not see`, () => {
      let caught: unknown;
      try {
        new ClaudeAgentSdkDriver({
          ...settings,
          tools: ["Read", "Bash"],
          toolArgsAllowlist: ["Bash(git status)"],
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ExternalAgentPolicyError);
      expect((caught as ExternalAgentPolicyError).code).toBe(
        EXTERNAL_AGENT_TOOL_ARGS_SETTINGS_UNCHECKED,
      );
    });
  }

  test("loaded settings without a toolArgsAllowlist are not refused", () => {
    expect(
      () =>
        new ClaudeAgentSdkDriver({
          settingSources: ["project"],
          inheritHostConfig: true,
        }),
    ).not.toThrow();
    expect(
      () =>
        new ClaudeAgentSdkDriver({
          settingSources: [],
          inheritHostConfig: false,
          toolArgsAllowlist: ["Bash(git status)"],
        }),
    ).not.toThrow();
  });

  test("options a host builds itself carry the guard", async () => {
    const { sdk } = hookSdk([]);
    const driver = new ClaudeAgentSdkDriver({
      sdk: sdk as never,
      tools: ["Bash"],
      toolArgsAllowlist: ["Bash(git log:*)"],
    });
    const built = [
      driver.buildOptions(request()),
      await driver.buildOptionsForRun(request(), sdk as never),
    ];
    for (const options of built) {
      const matchers =
        (options.hooks?.PreToolUse as Array<{ hooks: HookFn[] }>) ?? [];
      const decisions: string[] = [];
      for (const command of ["rm -rf .", "git log -5"]) {
        let decision = "ran";
        for (const matcher of matchers) {
          for (const hook of matcher.hooks) {
            const output = (await hook(
              {
                hook_event_name: "PreToolUse",
                tool_name: "Bash",
                tool_input: { command },
              },
              "tu",
              { signal: new AbortController().signal },
            )) as { hookSpecificOutput?: { permissionDecision?: string } };
            if (output.hookSpecificOutput?.permissionDecision === "deny") {
              decision = "denied";
            }
          }
        }
        decisions.push(`${command}:${decision}`);
      }
      expect(decisions).toEqual(["rm -rf .:denied", "git log -5:ran"]);
    }
  });

  test("checks shell tools whatever their casing, and denies Monitor", async () => {
    const { sdk, outcomes } = hookSdk([
      { tool: "bash", input: { command: "rm -rf ." } },
      { tool: "BASH", input: { command: "rm -rf ." } },
      { tool: "bash", input: { command: "git log -5" } },
      { tool: "powershell", input: { command: "git log" } },
      { tool: "Monitor", input: { command: "git log" } },
      { tool: "monitor", input: { command: "git log" } },
    ]);
    await drain(
      new ClaudeAgentSdkDriver({
        sdk: sdk as never,
        // Every shell tool is offered, so each denial comes from the
        // allowlist and not from the isolation hook.
        tools: ["Bash", "Monitor", "PowerShell"],
        toolArgsAllowlist: ["Bash(git log:*)"],
      }).run(request()),
    );
    expect(outcomes).toEqual([
      "rm -rf .:denied",
      "rm -rf .:denied",
      "git log -5:ran",
      "git log:denied",
      "git log:denied",
      "git log:denied",
    ]);
  });

  test("a malformed rule refuses the driver with a typed error", () => {
    let caught: unknown;
    try {
      new ClaudeAgentSdkDriver({ toolArgsAllowlist: ["Bash(git log:*"] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExternalAgentPolicyError);
    expect((caught as ExternalAgentPolicyError).code).toBe(
      EXTERNAL_AGENT_TOOL_ARGS_RULE_INVALID,
    );
  });
});
