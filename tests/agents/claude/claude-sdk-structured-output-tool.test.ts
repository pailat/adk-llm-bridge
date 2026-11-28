import { describe, expect, test } from "bun:test";
import {
  ClaudeAgentSdkDriver,
  type ClaudeAgentSdkDriverConfig,
} from "../../../src/agents/driver/claude-agent-sdk.js";
import { EXTERNAL_AGENT_ISOLATION_VIOLATED } from "../../../src/agents/driver/policy-errors.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import type { ExternalAgentRunRequest } from "../../../src/agents/external-agent-driver.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";

// With an outputSchema, Claude Code adds its own `StructuredOutput` tool to
// the session: system/init lists it and the model answers by calling it.
// An isolated run must accept that tool, and only when it has a schema.

const MODEL = "claude-haiku-5-5";
const SCHEMA = {
  type: "object",
  properties: { customer: { type: "string" }, path: { type: "string" } },
  required: ["customer"],
};
// The answer has a path-like key: it is data, not a file the tool touches.
const ANSWER = { customer: "Acme", path: "/etc/acme-ledger" };

const init = {
  type: "system",
  subtype: "init",
  model: MODEL,
  session_id: "s-1",
  tools: ["Read", "Grep", "Glob", "StructuredOutput"],
  mcp_servers: [],
};

const structuredCall = {
  type: "assistant",
  parent_tool_use_id: null,
  session_id: "s-1",
  message: {
    role: "assistant",
    model: MODEL,
    content: [
      {
        type: "tool_use",
        id: "toolu_so",
        name: "StructuredOutput",
        input: ANSWER,
      },
    ],
  },
};

const structuredResult = {
  type: "user",
  parent_tool_use_id: null,
  session_id: "s-1",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_so",
        content: "Structured output provided successfully",
      },
    ],
  },
};

const success = {
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  result: "",
  structured_output: ANSWER,
  session_id: "s-1",
  duration_ms: 5,
  total_cost_usd: 0.01,
};

type HookOutput = {
  hookSpecificOutput?: { permissionDecision?: string };
};
type Step =
  | Record<string, unknown>
  | ((options: Record<string, unknown>) => Promise<void>);

/** Runs the PreToolUse hooks and the permission callback as the runtime does. */
function callStructuredOutput(decisions: string[]): Step {
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
                  ) => Promise<HookOutput>
                >;
              }>;
            }
          | undefined
      )?.PreToolUse ?? [];
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        const out = await hook(
          {
            hook_event_name: "PreToolUse",
            tool_name: "StructuredOutput",
            tool_input: ANSWER,
            session_id: "s-1",
          },
          "toolu_so",
          { signal: new AbortController().signal },
        );
        decisions.push(out.hookSpecificOutput?.permissionDecision ?? "pass");
      }
    }
    const canUseTool = options.canUseTool as
      | ((
          name: string,
          input: Record<string, unknown>,
          extra: Record<string, unknown>,
        ) => Promise<{ behavior: string }>)
      | undefined;
    if (canUseTool) {
      const decision = await canUseTool("StructuredOutput", ANSWER, {
        signal: new AbortController().signal,
        toolUseID: "toolu_so",
      });
      decisions.push(`callback:${decision.behavior}`);
    }
  };
}

async function run(
  config: ClaudeAgentSdkDriverConfig,
  extra: Partial<ExternalAgentRunRequest> = {},
  decisions: string[] = [],
): Promise<ExternalAgentEvent[]> {
  const steps: Step[] = [
    init,
    structuredCall,
    callStructuredOutput(decisions),
    structuredResult,
    success,
  ];
  const sdk = {
    query: (input: { options: Record<string, unknown> }) =>
      (async function* () {
        for (const step of steps) {
          if (typeof step === "function") await step(input.options);
          else yield step;
        }
      })(),
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (config: Record<string, unknown>) => config,
  };
  const events: ExternalAgentEvent[] = [];
  for await (const event of new ClaudeAgentSdkDriver({
    sdk: sdk as never,
    model: MODEL,
    tools: ["Read", "Grep", "Glob"],
    ...config,
  }).run({
    provider: CLAUDE_PROVIDER,
    context: { input: "summarize Acme" } as never,
    workingDirectory: "/repo",
    ...extra,
  })) {
    events.push(event);
  }
  return events;
}

const errorCodes = (events: ExternalAgentEvent[]) =>
  events.flatMap((e) => (e.type === "error" ? [e.code] : []));
const outputs = (events: ExternalAgentEvent[]) =>
  events.flatMap((e) => (e.type === "output" ? [e.content] : []));
const exitCodes = (events: ExternalAgentEvent[]) =>
  events.flatMap((e) => (e.type === "completed" ? [e.exitCode] : []));

describe("the runtime's StructuredOutput tool under isolation", () => {
  test("a default isolated run with outputSchema accepts it", async () => {
    const decisions: string[] = [];
    const events = await run({ outputSchema: SCHEMA }, {}, decisions);
    expect(errorCodes(events)).toEqual([]);
    expect(decisions.every((d) => d === "pass")).toBe(true);
    expect(outputs(events)).toEqual([JSON.stringify(ANSWER)]);
    expect(exitCodes(events)).toEqual([0]);
  });

  test("it is not reported as an ordinary tool call", async () => {
    const events = await run({ outputSchema: SCHEMA });
    expect(
      events.filter((e) => e.type === "tool_call" || e.type === "tool_result"),
    ).toEqual([]);
  });

  test("allowedPaths does not read its answer as paths", async () => {
    const decisions: string[] = [];
    const events = await run(
      { outputSchema: SCHEMA },
      { permissions: { mode: "workspace-write", allowedPaths: ["/repo"] } },
      decisions,
    );
    expect(errorCodes(events)).toEqual([]);
    expect(decisions.every((d) => d === "pass")).toBe(true);
    expect(exitCodes(events)).toEqual([0]);
  });

  test("a read-only run whose host answers prompts allows it", async () => {
    const decisions: string[] = [];
    const asked: string[] = [];
    const events = await run(
      { outputSchema: SCHEMA },
      {
        permissions: { mode: "read-only" },
        requestPermission: async (request) => {
          asked.push(request.toolName);
          return { behavior: "deny", message: "read-only" };
        },
      },
      decisions,
    );
    expect(errorCodes(events)).toEqual([]);
    expect(decisions).toContain("callback:allow");
    expect(asked).toEqual([]);
    expect(exitCodes(events)).toEqual([0]);
  });

  test("without outputSchema it is still outside the isolated set", async () => {
    const events = await run({});
    expect(errorCodes(events)).toEqual([EXTERNAL_AGENT_ISOLATION_VIOLATED]);
  });
});
