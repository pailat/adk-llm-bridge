import { describe, expect, test } from "bun:test";
import { ClaudeAgentSdkDriver } from "../../../src/agents/driver/claude-agent-sdk.js";
import {
  ClaudeCliDriver,
  type ClaudeCliSpawn,
} from "../../../src/agents/driver/claude-cli.js";
import {
  CodexCliDriver,
  type CodexCliSpawn,
} from "../../../src/agents/driver/codex-cli.js";
import { CodexSdkDriver } from "../../../src/agents/driver/codex-sdk.js";
import {
  GeminiCliDriver,
  type GeminiCliSpawn,
} from "../../../src/agents/driver/gemini-cli.js";
import {
  EXTERNAL_AGENT_DEPENDENCY_MISSING,
  EXTERNAL_AGENT_MISSING_BINARY,
  isCommandNotFound,
} from "../../../src/agents/driver/policy-errors.js";
import {
  type SpawnRuntime,
  spawnSubprocess,
} from "../../../src/agents/driver/spawn.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import type { ExternalAgentRunRequest } from "../../../src/agents/external-agent-driver.js";
import { CODEX_PROVIDER } from "../../../src/agents/provider/codex.js";
import { GEMINI_CLI_PROVIDER } from "../../../src/agents/provider/gemini-cli.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";
import { GEMINI_NETWORK_ON, noHostMcpServers } from "../helpers.js";

const MISSING = "/nonexistent/adk-llm-bridge-test-binary";

function request(provider = CLAUDE_PROVIDER): ExternalAgentRunRequest {
  return { provider, context: { input: "hi" } as never };
}

async function collect(
  run: AsyncIterable<ExternalAgentEvent>,
): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

function expectRefused(
  events: ExternalAgentEvent[],
  code: string,
  install: string,
): void {
  expect(events.map((event) => event.type)).toEqual([
    "started",
    "error",
    "completed",
  ]);
  expect(events[1]).toMatchObject({ code, recoverable: false });
  expect((events[1] as { message: string }).message).toContain(install);
  expect(events[2]).toMatchObject({ exitCode: 1 });
}

const missingModule = async () => {
  throw new Error("Cannot find module");
};

describe("a missing SDK package is an error event, not a throw", () => {
  test("Claude Agent SDK", async () => {
    const events = await collect(
      new ClaudeAgentSdkDriver({ importSdk: missingModule }).run(request()),
    );
    expectRefused(
      events,
      EXTERNAL_AGENT_DEPENDENCY_MISSING,
      "npm install @anthropic-ai/claude-agent-sdk",
    );
  });

  test("Codex SDK", async () => {
    const events = await collect(
      new CodexSdkDriver({ importSdk: missingModule as never }).run(
        request(CODEX_PROVIDER),
      ),
    );
    expectRefused(
      events,
      EXTERNAL_AGENT_DEPENDENCY_MISSING,
      "npm install @openai/codex-sdk",
    );
  });

  test("Codex SDK reports the missing package before listing MCP servers", async () => {
    let listed = 0;
    const events = await collect(
      new CodexSdkDriver({
        importSdk: missingModule as never,
        listMcpServers: async () => {
          listed++;
          throw new Error("codex mcp list failed");
        },
      }).run(request(CODEX_PROVIDER)),
    );
    expectRefused(
      events,
      EXTERNAL_AGENT_DEPENDENCY_MISSING,
      "npm install @openai/codex-sdk",
    );
    expect(listed).toBe(0);
  });
});

for (const [label, runtime] of [
  ["Bun", {}],
  ["Node", { bun: null }],
] as Array<[string, SpawnRuntime]>) {
  describe(`a missing CLI binary is an error event (${label} spawn)`, () => {
    const spawn = ((command, args, options) =>
      spawnSubprocess(command, args, options, runtime)) as ClaudeCliSpawn &
      CodexCliSpawn &
      GeminiCliSpawn;

    test("Claude CLI", async () => {
      const events = await collect(
        new ClaudeCliDriver({ command: MISSING, spawn }).run(request()),
      );
      expectRefused(
        events,
        EXTERNAL_AGENT_MISSING_BINARY,
        "npm install -g @anthropic-ai/claude-code",
      );
    });

    test("Codex CLI", async () => {
      const events = await collect(
        new CodexCliDriver({
          listMcpServers: noHostMcpServers,
          command: MISSING,
          spawn,
        }).run(request(CODEX_PROVIDER)),
      );
      expectRefused(
        events,
        EXTERNAL_AGENT_MISSING_BINARY,
        "npm install -g @openai/codex",
      );
    });

    test("Gemini CLI", async () => {
      const events = await collect(
        new GeminiCliDriver({ command: MISSING, spawn }).run({
          ...request(GEMINI_CLI_PROVIDER),
          permissions: GEMINI_NETWORK_ON,
        }),
      );
      expectRefused(
        events,
        EXTERNAL_AGENT_MISSING_BINARY,
        "npm install -g @google/gemini-cli",
      );
    });
  });
}

describe("isCommandNotFound", () => {
  test("matches ENOENT codes and messages only", () => {
    expect(isCommandNotFound({ code: "ENOENT" })).toBe(true);
    expect(isCommandNotFound(new Error("spawn claude ENOENT"))).toBe(true);
    expect(isCommandNotFound(new Error("Executable not found in $PATH"))).toBe(
      true,
    );
    expect(isCommandNotFound(new Error("permission denied"))).toBe(false);
    expect(isCommandNotFound("ENOENT")).toBe(false);
  });
});
