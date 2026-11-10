import { describe, expect, test } from "bun:test";
import { ClaudeAgentSdkDriver } from "../../../src/agents/driver/claude-agent-sdk.js";
import {
  EXTERNAL_AGENT_ISOLATION_VIOLATED,
  EXTERNAL_AGENT_TOOL_NOT_OFFERED,
} from "../../../src/agents/driver/policy-errors.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import type { ExternalAgentRunRequest } from "../../../src/agents/external-agent-driver.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";

// Message shapes as the Claude Agent SDK streams them for a tool the model
// invents: the assistant `tool_use`, then the runtime's own refusal as an
// error `tool_result` (text from a captured run), before any hook runs.
const REFUSAL =
  "<tool_use_error>Error: No such tool available: Bash. Bash is disabled for this session, in subagents as well as here.</tool_use_error>";

const INIT = {
  type: "system",
  subtype: "init",
  model: "claude-haiku-5-5",
  session_id: "s-1",
  tools: ["Glob", "Grep", "Read"],
  mcp_servers: [],
};

function toolUse(name: string, id: string) {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    session_id: "s-1",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input: { command: "echo" } }],
    },
  };
}

function toolResult(
  id: string,
  isError: boolean | undefined,
  content: unknown = REFUSAL,
) {
  return {
    type: "user",
    parent_tool_use_id: null,
    session_id: "s-1",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content,
          ...(isError === undefined ? {} : { is_error: isError }),
        },
      ],
    },
  };
}

const TEXT = {
  type: "assistant",
  parent_tool_use_id: null,
  session_id: "s-1",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Found it." }],
  },
};

const RESULT = {
  type: "result",
  subtype: "success",
  result: "Found it.",
  session_id: "s-1",
};

type Step =
  | Record<string, unknown>
  | ((options: Record<string, unknown>) => Promise<void>);

/** A fake SDK that streams `steps`; a function step acts on the run options. */
function sdkOf(steps: Step[]) {
  const state: { options?: Record<string, unknown> } = {};
  const sdk = {
    query: (input: { options: Record<string, unknown> }) => {
      state.options = input.options;
      return (async function* () {
        for (const step of steps) {
          if (typeof step === "function") await step(input.options);
          else yield step;
        }
      })();
    },
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (config: Record<string, unknown>) => config,
  };
  return { sdk, state };
}

function request(extra: Partial<ExternalAgentRunRequest> = {}) {
  return {
    provider: CLAUDE_PROVIDER,
    context: { input: "hi" } as never,
    workingDirectory: "/repo",
    permissions: { mode: "read-only" as const },
    ...extra,
  };
}

async function run(
  steps: Step[],
  extra: Partial<ExternalAgentRunRequest> = {},
): Promise<ExternalAgentEvent[]> {
  const { sdk } = sdkOf(steps);
  const events: ExternalAgentEvent[] = [];
  for await (const event of new ClaudeAgentSdkDriver({
    sdk: sdk as never,
    tools: ["Read", "Grep", "Glob"],
  }).run(request(extra))) {
    events.push(event);
  }
  return events;
}

const errorOf = (events: ExternalAgentEvent[]) =>
  events.find((event) => event.type === "error");

/** Runs the PreToolUse hooks as the runtime does for a tool that exists. */
function runHooks(toolName: string, id: string): Step {
  return async (options) => {
    const matchers =
      (
        options.hooks as
          | {
              PreToolUse?: Array<{
                hooks: Array<
                  (
                    input: Record<string, unknown>,
                    toolUseId: string,
                    extra: { signal: AbortSignal },
                  ) => Promise<unknown>
                >;
              }>;
            }
          | undefined
      )?.PreToolUse ?? [];
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        await hook({ hook_event_name: "PreToolUse", tool_name: toolName }, id, {
          signal: new AbortController().signal,
        });
      }
    }
  };
}

describe("a tool the model invents and the runtime refuses", () => {
  test("does not stop the run and is reported on its tool_result", async () => {
    const events = await run([
      INIT,
      toolUse("Bash", "toolu_1"),
      toolResult("toolu_1", true),
      TEXT,
      RESULT,
    ]);

    expect(errorOf(events)).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
    const result = events.find(
      (event) => event.type === "tool_result" && event.callId === "toolu_1",
    );
    expect(result).toMatchObject({
      name: "Bash",
      error: expect.stringContaining("No such tool available"),
      metadata: { isolation: EXTERNAL_AGENT_TOOL_NOT_OFFERED },
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "output", content: "Found it." }),
    );
  });

  test("an error result given as content blocks counts the same", async () => {
    const events = await run([
      INIT,
      toolUse("Bash", "toolu_1"),
      toolResult("toolu_1", true, [{ type: "text", text: REFUSAL }]),
      RESULT,
    ]);
    expect(errorOf(events)).toBeUndefined();
  });

  test("two refused calls are tolerated; the third stops the run", async () => {
    const two = await run([
      INIT,
      toolUse("Bash", "toolu_1"),
      toolResult("toolu_1", true),
      toolUse("Write", "toolu_2"),
      toolResult("toolu_2", true),
      RESULT,
    ]);
    expect(errorOf(two)).toBeUndefined();

    const three = await run([
      INIT,
      toolUse("Bash", "toolu_1"),
      toolResult("toolu_1", true),
      toolUse("Write", "toolu_2"),
      toolResult("toolu_2", true),
      toolUse("Bash", "toolu_3"),
      toolResult("toolu_3", true),
      TEXT,
      RESULT,
    ]);
    expect(errorOf(three)).toMatchObject({
      code: EXTERNAL_AGENT_ISOLATION_VIOLATED,
      recoverable: false,
      message: expect.stringContaining("3 tools it was not offered"),
    });
    expect(three.some((event) => event.type === "completed")).toBe(true);
    expect(
      three.some(
        (event) => event.type === "output" && event.content === "Found it.",
      ),
    ).toBe(false);
  });
});

describe("an out-of-set call still stops the run when", () => {
  test("the runtime ran it (a successful result)", async () => {
    for (const isError of [false, undefined]) {
      const events = await run([
        INIT,
        toolUse("Bash", "toolu_1"),
        toolResult("toolu_1", isError, "ok"),
        TEXT,
        RESULT,
      ]);
      expect(errorOf(events)).toMatchObject({
        code: EXTERNAL_AGENT_ISOLATION_VIOLATED,
        message: expect.stringContaining("ran"),
      });
      expect(
        events.some(
          (event) => event.type === "output" && event.content === "Found it.",
        ),
      ).toBe(false);
    }
  });

  test("the isolation hook fired for it (the tool exists)", async () => {
    const events = await run([
      INIT,
      toolUse("Bash", "toolu_1"),
      runHooks("Bash", "toolu_1"),
      toolResult("toolu_1", true, "denied"),
      RESULT,
    ]);
    expect(errorOf(events)).toMatchObject({
      code: EXTERNAL_AGENT_ISOLATION_VIOLATED,
    });
  });

  test("the hook fired for it after two refused calls: the block is reported, not the count", async () => {
    const events = await run([
      INIT,
      toolUse("Bash", "toolu_1"),
      toolResult("toolu_1", true),
      toolUse("Write", "toolu_2"),
      toolResult("toolu_2", true),
      toolUse("Bash", "toolu_3"),
      runHooks("Bash", "toolu_3"),
      toolResult("toolu_3", true, "denied"),
      RESULT,
    ]);
    expect(errorOf(events)).toMatchObject({
      code: EXTERNAL_AGENT_ISOLATION_VIOLATED,
      message: expect.stringContaining("the call was blocked"),
    });
  });

  test("the permission callback was asked about it (the tool exists)", async () => {
    const events = await run(
      [
        INIT,
        toolUse("Bash", "toolu_1"),
        async (options) => {
          const canUseTool = options.canUseTool as (
            name: string,
            input: Record<string, unknown>,
            extra: { signal: AbortSignal; toolUseID: string },
          ) => Promise<unknown>;
          await canUseTool(
            "Bash",
            {},
            { signal: new AbortController().signal, toolUseID: "toolu_1" },
          );
        },
        toolResult("toolu_1", true, "denied"),
        RESULT,
      ],
      {
        permissions: { mode: "ask" as never },
        requestPermission: async () => ({ behavior: "allow" }) as never,
      },
    );
    expect(errorOf(events)).toMatchObject({
      code: EXTERNAL_AGENT_ISOLATION_VIOLATED,
    });
  });

  test("no result arrives before the run's result", async () => {
    const events = await run([INIT, toolUse("Bash", "toolu_1"), RESULT]);
    expect(errorOf(events)).toMatchObject({
      code: EXTERNAL_AGENT_ISOLATION_VIOLATED,
    });
    expect(events.some((event) => event.type === "completed")).toBe(true);
    expect(
      events.find((event) => event.type === "completed"),
    ).not.toMatchObject({ exitCode: 0 });
  });

  test("the stream ends without a result for it", async () => {
    const events = await run([INIT, toolUse("Bash", "toolu_1")]);
    expect(errorOf(events)).toMatchObject({
      code: EXTERNAL_AGENT_ISOLATION_VIOLATED,
    });
  });

  test("the error result answers another call", async () => {
    const events = await run([
      INIT,
      toolUse("Bash", "toolu_1"),
      toolResult("toolu_other", true),
      RESULT,
    ]);
    expect(errorOf(events)).toMatchObject({
      code: EXTERNAL_AGENT_ISOLATION_VIOLATED,
    });
  });

  test("the runtime offered the tool (a host or managed setting)", async () => {
    const events = await run([
      { ...INIT, tools: [...INIT.tools, "Bash"] },
      toolUse("Bash", "toolu_1"),
      toolResult("toolu_1", true),
      RESULT,
    ]);
    expect(errorOf(events)).toMatchObject({
      code: EXTERNAL_AGENT_ISOLATION_VIOLATED,
      message: expect.stringContaining("host or managed setting"),
    });
  });

  test("it is an MCP tool (a server may connect after start)", async () => {
    const events = await run([
      INIT,
      toolUse("mcp__claude_ai_Gmail__send", "toolu_1"),
      toolResult("toolu_1", true),
      RESULT,
    ]);
    expect(errorOf(events)).toMatchObject({
      code: EXTERNAL_AGENT_ISOLATION_VIOLATED,
    });
  });

  test("it comes before system/init", async () => {
    const events = await run([
      toolUse("Bash", "toolu_1"),
      toolResult("toolu_1", true),
      INIT,
      RESULT,
    ]);
    expect(errorOf(events)).toMatchObject({
      code: EXTERNAL_AGENT_ISOLATION_VIOLATED,
    });
  });

  test("it has no call id or no name", async () => {
    for (const block of [
      { type: "tool_use", name: "Bash", input: {} },
      { type: "tool_use", id: "", name: "Bash", input: {} },
      { type: "tool_use", id: "toolu_1", input: {} },
    ]) {
      const events = await run([
        INIT,
        { type: "assistant", message: { role: "assistant", content: [block] } },
        toolResult("toolu_1", true),
        TEXT,
        RESULT,
      ]);
      expect(errorOf(events)).toMatchObject({
        code: EXTERNAL_AGENT_ISOLATION_VIOLATED,
      });
      // Stopped at the call itself, not at the end of the run.
      expect(
        events.some(
          (event) => event.type === "output" && event.content === "Found it.",
        ),
      ).toBe(false);
    }
  });
});
