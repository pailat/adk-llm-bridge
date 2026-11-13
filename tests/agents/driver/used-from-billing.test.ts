/**
 * `used` reports billing data only. Both Claude drivers fill a missing
 * `completed.model` from the init message so `resolved` stays known, but that
 * model is a guess for `used`: the `completed` event says so with
 * `modelFromInit`, and `ExternalAgent` then reports no `used` at all.
 */

import { describe, expect, test } from "bun:test";
import type { Event, InvocationContext } from "@google/adk";
import { ClaudeAgentSdkDriver } from "../../../src/agents/driver/claude-agent-sdk.js";
import { ClaudeCliDriver } from "../../../src/agents/driver/claude-cli.js";
import {
  CLAUDE_PROVIDER,
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentEvent,
  type ExternalAgentModelInfo,
} from "../../../src/agents/index.js";

const INIT = { type: "system", subtype: "init", model: "claude-main" };
const RESULT = { type: "result", subtype: "success", result: "ok" };
const WITH_USAGE = {
  ...RESULT,
  modelUsage: { "claude-main": { inputTokens: 1, outputTokens: 1 } },
};

type Kind = "sdk" | "cli";

function build(kind: Kind, messages: unknown[]): ExternalAgentDriver {
  if (kind === "sdk") {
    return new ClaudeAgentSdkDriver({
      env: { PATH: "/usr/bin:/bin" },
      pathToClaudeCodeExecutable: "/example/bin/claude",
      sdk: {
        query: () =>
          (async function* () {
            for (const message of messages) yield message as never;
          })() as never,
      },
    } as never);
  }
  return new ClaudeCliDriver({
    env: { PATH: "/usr/bin:/bin" },
    spawn: () => ({
      stdout: messages.map((line) => `${JSON.stringify(line)}\n`),
      stderr: [],
      exited: Promise.resolve(0),
    }),
  } as never);
}

async function completedOf(driver: ExternalAgentDriver) {
  const events: ExternalAgentEvent[] = [];
  for await (const event of driver.run({
    provider: CLAUDE_PROVIDER,
    context: {} as never,
    instruction: "go",
    permissions: { mode: "workspace-write", allowNetwork: true },
  })) {
    events.push(event);
  }
  return events.find((event) => event.type === "completed") as Extract<
    ExternalAgentEvent,
    { type: "completed" }
  >;
}

async function infoOf(driver: ExternalAgentDriver) {
  const agent = new ExternalAgent({
    name: "agent",
    provider: CLAUDE_PROVIDER,
    driver,
  });
  const events: Event[] = [];
  for await (const event of agent.runAsync({
    invocationId: "inv-1",
    branch: "root.agent",
  } as InvocationContext)) {
    events.push(event);
  }
  return events.at(-1)?.customMetadata
    ?.externalAgentModel as ExternalAgentModelInfo;
}

for (const kind of ["sdk", "cli"] as const) {
  describe(`${kind}: a model filled from init is not billing data`, () => {
    test("no modelUsage: completed.model is the init model, flagged", async () => {
      const completed = await completedOf(build(kind, [INIT, RESULT]));
      expect(completed.model).toBe("claude-main");
      expect(completed.modelFromInit).toBe(true);
    });

    test("no modelUsage: resolved is known, used and unexpected are absent", async () => {
      const info = await infoOf(build(kind, [INIT, RESULT]));
      expect(info.status).toBe("reported");
      expect(info.resolved).toBe("claude-main");
      expect(info).not.toHaveProperty("used");
      expect(info).not.toHaveProperty("unexpected");
    });

    test("one modelUsage model: used is that model, no flag", async () => {
      const driver = build(kind, [INIT, WITH_USAGE]);
      const completed = await completedOf(driver);
      expect(completed.model).toBe("claude-main");
      expect(completed).not.toHaveProperty("modelFromInit");
      const info = await infoOf(build(kind, [INIT, WITH_USAGE]));
      expect(info.used).toEqual(["claude-main"]);
      expect(info.unexpected).toEqual([]);
    });
  });
}

describe("ExternalAgent ignores a flagged completed.model", () => {
  const flagged = (flag: boolean | undefined): ExternalAgentDriver =>
    ({
      providerId: CLAUDE_PROVIDER.id,
      model: "a",
      reportsResolvedModel: true,
      async *run() {
        yield { type: "started", providerId: CLAUDE_PROVIDER.id };
        yield { type: "output", content: "x" };
        yield {
          type: "completed",
          exitCode: 0,
          model: "a",
          ...(flag === undefined ? {} : { modelFromInit: flag }),
        };
      },
    }) as ExternalAgentDriver;

  test("flagged: no used", async () => {
    const info = await infoOf(flagged(true));
    expect(info.resolved).toBe("a");
    expect(info).not.toHaveProperty("used");
  });

  test("false or absent: used", async () => {
    expect((await infoOf(flagged(false))).used).toEqual(["a"]);
    expect((await infoOf(flagged(undefined))).used).toEqual(["a"]);
  });
});
