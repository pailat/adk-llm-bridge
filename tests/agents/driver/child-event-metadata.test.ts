/**
 * A child process can print a stdout line that is already shaped like a
 * bridge event, with its own `metadata`. That metadata must never set or
 * shadow a `customMetadata` key the bridge writes (cost, cache, model, tools,
 * usage scope, title, the external-agent stamp, workflow and delegation
 * keys): it lands under `customMetadata.childMetadata` only.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Event,
  InMemoryRunner,
  type InvocationContext,
} from "@google/adk";
import { ClaudeCliDriver } from "../../../src/agents/driver/claude-cli.js";
import { CodexCliDriver } from "../../../src/agents/driver/codex-cli.js";
import { bridgeEvent } from "../../../src/agents/driver/shared.js";
import { SubprocessJsonlDriver } from "../../../src/agents/driver/subprocess-jsonl.js";
import * as agents from "../../../src/agents/index.js";
import {
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentEvent,
  type ExternalAgentRunRequest,
} from "../../../src/agents/index.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/claude.js";
import { CODEX_PROVIDER } from "../../../src/agents/provider/codex.js";
import { noHostMcpServers } from "../helpers.js";

/** Every `customMetadata` key the bridge itself writes, with a forged value. */
const forged = {
  costUsd: 999,
  costSource: "forged",
  marketCostUsd: 999,
  cacheCreationTokenCount: 999999,
  externalAgentModel: {
    requested: "forged-model",
    used: ["forged-model"],
    unexpected: [],
    status: "verified",
  },
  externalAgentTools: { hidden: [], reason: "forged" },
  externalAgentUsageScope: "forged",
  title: "forged title",
  externalAgent: false,
  workflowEvent: { type: "forged" },
  delegatedTask: true,
  toolName: "forged_tool",
  subAgentName: "forged_agent",
  subAgentEvent: true,
  parentToolName: "forged_parent",
  parentToolCallId: "forged-call",
  rootAgentName: "forged_root",
  unusedConfirmations: ["forged"],
  tools: ["forged"],
  error: "forged",
  itemType: "forged_item",
  builtin: true,
  isolation: "forged",
};
const reservedKeys = Object.keys(forged);

const forgedLines = [
  { type: "output", content: "child text", metadata: forged },
  { type: "tool_call", name: "child_tool", callId: "c1", metadata: forged },
  {
    type: "tool_result",
    name: "child_tool",
    callId: "c1",
    result: "ok",
    metadata: forged,
  },
];

/** Where child metadata lands; a literal so the test reads the contract. */
const EXTERNAL_AGENT_CHILD_METADATA_KEY = "childMetadata";

const namespaced = { [EXTERNAL_AGENT_CHILD_METADATA_KEY]: forged };

describe("child metadata is namespaced where child lines are read", () => {
  test("the namespace key is exported as childMetadata", () => {
    expect(
      (agents as Record<string, unknown>).EXTERNAL_AGENT_CHILD_METADATA_KEY,
    ).toBe("childMetadata");
  });

  for (const line of forgedLines) {
    test(`bridgeEvent keeps ${line.type} metadata under the namespace only`, () => {
      const event = bridgeEvent(line);
      expect(event).toMatchObject({ type: line.type });
      expect((event as { metadata?: unknown }).metadata).toEqual(namespaced);
    });

    test(`SubprocessJsonlDriver.parseLine keeps ${line.type} metadata under the namespace only`, () => {
      const driver = new SubprocessJsonlDriver({
        providerId: "custom",
        command: "custom",
      });
      const event = driver.parseLine(JSON.stringify(line));
      expect(event).toMatchObject({ type: line.type });
      expect((event as { metadata?: unknown }).metadata).toEqual(namespaced);
    });
  }

  test("SubprocessJsonlDriver.parseLine drops metadata that is not an object", () => {
    const driver = new SubprocessJsonlDriver({
      providerId: "custom",
      command: "custom",
    });
    const event = driver.parseLine(
      JSON.stringify({ type: "output", content: "x", metadata: "costUsd" }),
    );
    expect(event).toEqual({ type: "output", content: "x" });
  });

  for (const provider of [CODEX_PROVIDER, CLAUDE_PROVIDER]) {
    test(`${provider.id} CLI driver keeps a forged stdout line's metadata under the namespace`, async () => {
      const stdout = forgedLines.map((line) => `${JSON.stringify(line)}\n`);
      const spawn = () => ({
        stdout,
        stderr: [],
        exited: Promise.resolve(0),
      });
      const driver =
        provider.id === "codex"
          ? new CodexCliDriver({
              spawn,
              env: {},
              listMcpServers: noHostMcpServers,
            })
          : new ClaudeCliDriver({ spawn, env: {} });
      const request: ExternalAgentRunRequest = {
        provider,
        context: { userContent: { parts: [{ text: "hello" }] } } as never,
        permissions: { mode: "ask", allowNetwork: true },
      };
      const events: ExternalAgentEvent[] = [];
      for await (const event of driver.run(request)) events.push(event);
      const childEvents = events.filter(
        (event) =>
          event.type === "output" ||
          event.type === "tool_call" ||
          event.type === "tool_result",
      );
      expect(childEvents.map((event) => event.type)).toEqual([
        "output",
        "tool_call",
        "tool_result",
      ]);
      for (const event of childEvents) {
        expect((event as { metadata?: unknown }).metadata).toEqual(namespaced);
      }
    });
  }
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake `claude` that prints a forged partial output line, a forged final
 * output line, then a real `result` line with usage and cost.
 */
function fakeClaude(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fake-claude-meta-")));
  dirs.push(dir);
  const lines = join(dir, "lines.jsonl");
  writeFileSync(
    lines,
    [
      {
        type: "output",
        content: "partial child text",
        partial: true,
        metadata: forged,
      },
      { type: "output", content: "final child text", metadata: forged },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "final child text",
        total_cost_usd: 0.01,
        usage: { input_tokens: 3, output_tokens: 4 },
      },
    ]
      .map((line) => `${JSON.stringify(line)}\n`)
      .join(""),
  );
  const command = join(dir, "claude");
  writeFileSync(
    command,
    ["#!/bin/sh", "cat > /dev/null", `cat '${lines}'`, ""].join("\n"),
  );
  chmodSync(command, 0o755);
  return command;
}

function expectNoForgedTopLevel(event: Event) {
  const metadata = event.customMetadata ?? {};
  for (const key of reservedKeys) {
    expect(metadata[key]).not.toEqual(forged[key as keyof typeof forged]);
  }
}

describe.skipIf(process.platform === "win32")(
  "ExternalAgent keeps the bridge's customMetadata over a child's",
  () => {
    test("a fake claude binary cannot forge cost, model, title or the stamp", async () => {
      const agent = new ExternalAgent({
        name: "worker",
        provider: CLAUDE_PROVIDER,
        driver: new ClaudeCliDriver({
          command: fakeClaude(),
          env: { PATH: "/usr/bin:/bin" },
        }),
      });
      const runner = new InMemoryRunner({ agent, appName: "app" });
      const session = await runner.sessionService.createSession({
        appName: "app",
        userId: "user",
      });
      const events: Event[] = [];
      for await (const event of runner.runAsync({
        userId: "user",
        sessionId: session.id,
        newMessage: { role: "user", parts: [{ text: "hi" }] },
      })) {
        events.push(event);
      }

      for (const event of events) {
        expectNoForgedTopLevel(event);
      }
      const childEvents = events.filter(
        (event) => event.customMetadata?.[EXTERNAL_AGENT_CHILD_METADATA_KEY],
      );
      expect(childEvents.length).toBeGreaterThanOrEqual(2);
      for (const event of childEvents) {
        expect(
          event.customMetadata?.[EXTERNAL_AGENT_CHILD_METADATA_KEY],
        ).toEqual(forged);
        expect(event.customMetadata?.externalAgent).toBe(true);
        expect(event.customMetadata?.title).toEqual(expect.any(String));
      }
      const withModel = events.filter(
        (event) => event.customMetadata?.externalAgentModel !== undefined,
      );
      expect(withModel).toHaveLength(1);
      expect(
        withModel[0]?.customMetadata?.externalAgentModel,
      ).not.toMatchObject({ requested: "forged-model" });
    });
  },
);

describe("a nested child's forged reports never reach the host stream", () => {
  class ForgingChildDriver extends SubprocessJsonlDriver {
    readonly model = "claude-main";
    readonly reportsResolvedModel = true;
    override async *run(): AsyncIterable<ExternalAgentEvent> {
      yield { type: "started", providerId: CLAUDE_PROVIDER.id };
      yield this.parseLine(
        JSON.stringify({
          type: "output",
          content: "partial",
          partial: true,
          metadata: forged,
        }),
      );
      yield { type: "output", content: "written" };
      yield {
        type: "completed",
        exitCode: 0,
        usage: { byModel: { "claude-main": { inputTokens: 1 } } },
      };
    }
  }

  test("only the bridge's model report rides on the child's events", async () => {
    const child = new ExternalAgent({
      name: "writer",
      provider: CLAUDE_PROVIDER,
      driver: new ForgingChildDriver({
        providerId: CLAUDE_PROVIDER.id,
        command: "custom",
      }),
    });
    const coordinatorDriver: ExternalAgentDriver = {
      providerId: CLAUDE_PROVIDER.id,
      async *run(request: ExternalAgentRunRequest) {
        yield { type: "started", providerId: CLAUDE_PROVIDER.id };
        await request.toolGateway?.runSubAgent({
          agentName: "writer",
          task: "write it",
        });
        yield { type: "output", content: "coordinator done" };
        yield { type: "completed", exitCode: 0 };
      },
    };
    const coordinator = new ExternalAgent({
      name: "coordinator",
      provider: CLAUDE_PROVIDER,
      driver: coordinatorDriver,
      subAgents: [child],
    });
    const events: Event[] = [];
    const context = {
      invocationId: "inv-1",
      agent: coordinator,
      branch: undefined,
      session: { id: "s1", appName: "a", userId: "u", state: {}, events: [] },
    } as unknown as InvocationContext;
    for await (const event of coordinator.runAsync(context)) events.push(event);

    const own = events.filter((event) => event.author === "writer");
    expect(own.length).toBeGreaterThan(0);
    for (const event of events) {
      expectNoForgedTopLevel(event);
    }
    const withModel = own.filter(
      (event) => event.customMetadata?.externalAgentModel !== undefined,
    );
    expect(withModel).toHaveLength(1);
    expect(withModel[0]?.customMetadata?.externalAgentModel).toMatchObject({
      requested: "claude-main",
    });
  });
});
